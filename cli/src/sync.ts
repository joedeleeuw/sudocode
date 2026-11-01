/**
 * Bidirectional sync between Markdown files and JSONL/SQLite
 */

import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import {
  parseMarkdownFile,
  replaceFrontmatter,
  updateFrontmatterFile,
  writeMarkdownFile,
} from "./markdown.js";
import type { CrossReference } from "./markdown.js";
import {
  getSpec,
  getSpecByFilePath,
  createSpec,
  updateSpec,
} from "./operations/specs.js";
import { getIssue, createIssue, updateIssueRow } from "./operations/issues.js";
import {
  getAdr,
  getAdrByFilePath,
  createAdr,
  updateAdr,
} from "./operations/adrs.js";
import { getEntity } from "./operations/entities.js";
import { addRelationshipRow } from "./operations/relationships.js";
import { getTags, setTags } from "./operations/tags.js";
import { listFeedback, updateFeedback } from "./operations/feedback.js";
import { relocateFeedbackAnchor } from "./operations/feedback-anchors.js";
import { exportToJSONL } from "./export.js";
import { generateEntityId } from "./id-generator.js";
import type { Adr, EntityType, Spec, Issue, IssueStatus } from "@sudocode-ai/types";
import {
  ENTITY_ROWS,
  parseEntityType,
  type DocumentEntityType,
  type Entity,
} from "@sudocode-ai/types/entities";
import { isValidIssueStatus, isValidRelationshipType } from "./validation.js";

export interface MarkdownSyncResult {
  success: boolean;
  action: "created" | "updated" | "no-change";
  entityId: string;
  entityType: EntityType;
  error?: string;
}

export interface SyncOptions {
  /**
   * Directory for JSONL output (default: .sudocode)
   */
  outputDir?: string;
  /**
   * Whether to auto-export to JSONL after sync (default: true)
   */
  autoExport?: boolean;
  /**
   * User performing the sync
   */
  user?: string;
  /**
   * Auto-initialize missing frontmatter fields (default: true)
   * If true, generates missing IDs and provides default values
   * If false, rejects files with missing required fields
   */
  autoInitialize?: boolean;
  /**
   * Whether to write back initialized frontmatter to the file (default: true)
   * Only applies when autoInitialize is true
   */
  writeBackFrontmatter?: boolean;
}

interface DocumentSyncCase<K extends DocumentEntityType> {
  get(db: Database.Database, id: string): Entity<K> | null;
  getByFilePath(db: Database.Database, filePath: string): Entity<K> | null;
  contentChanged(
    entity: Entity<K> | null,
    frontmatter: Record<string, any>,
    content: string,
    filePath: string
  ): boolean;
  sync(
    db: Database.Database,
    id: string,
    frontmatter: Record<string, any>,
    content: string,
    isNew: boolean,
    updatedAt?: string
  ): void;
}

type DocumentSyncTable = {
  [K in DocumentEntityType]: DocumentSyncCase<K>;
};

const DOCUMENT_SYNC_CASES = {
  spec: {
    get: getSpec,
    getByFilePath: getSpecByFilePath,
    contentChanged(entity, frontmatter, content, filePath) {
      if (entity === null) return true;
      return (
        entity.title !== frontmatter.title ||
        entity.content !== content ||
        entity.file_path !== filePath ||
        entity.priority !== (frontmatter.priority ?? 2) ||
        entity.parent_id !== (frontmatter.parent_id || undefined)
      );
    },
    sync(db, id, frontmatter, content, isNew, updatedAt) {
      const input = {
        title: frontmatter.title || "Untitled",
        file_path: frontmatter.file_path || "",
        content,
        priority: frontmatter.priority ?? 2,
        parent_id: frontmatter.parent_id || undefined,
      };
      if (isNew) {
        createSpec(db, { id, ...input, updated_at: updatedAt });
      } else {
        updateSpec(db, id, { ...input, updated_at: updatedAt });
      }
    },
  },
  adr: {
    get: getAdr,
    getByFilePath: getAdrByFilePath,
    contentChanged(entity, frontmatter, content, filePath) {
      return (
        entity?.title !== frontmatter.title ||
        entity?.content !== content ||
        entity?.file_path !== filePath
      );
    },
    sync(db, id, frontmatter, content, isNew, updatedAt) {
      const input = {
        title: frontmatter.title || "Untitled",
        file_path: frontmatter.file_path || "",
        content,
        archived: frontmatter.archived,
        archived_at: frontmatter.archived_at,
      };
      if (isNew) {
        createAdr(db, { id, ...input, updated_at: updatedAt });
      } else {
        updateAdr(db, id, { ...input, updated_at: updatedAt });
      }
    },
  },
} satisfies DocumentSyncTable;

function documentSyncCase<K extends DocumentEntityType>(entityType: K): DocumentSyncCase<K> {
  return DOCUMENT_SYNC_CASES[entityType];
}

/**
 * Remove internal fields that shouldn't be in markdown frontmatter
 * These fields are only for database tracking, not for the markdown files
 */
function cleanFrontmatterForMarkdown(
  data: Record<string, any>
): Record<string, any> {
  const { file_path, entity_type, ...clean } = data;
  return clean;
}

/**
 * Initialize missing frontmatter fields
 */
function initializeFrontmatter(
  db: Database.Database,
  data: Record<string, any>,
  entityType: EntityType,
  mdPath: string,
  _outputDir: string,
  _user: string
): Record<string, any> {
  const now = new Date().toISOString();
  const initialized = { ...data };

  // Generate ID and UUID if missing
  if (!initialized.id) {
    const generated = generateEntityId(db, entityType);
    initialized.id = generated.id;
    initialized.uuid = generated.uuid;
  }

  // Extract title from content if missing
  if (!initialized.title) {
    const content = fs.readFileSync(mdPath, "utf8");
    const titleMatch = content.match(/^#\s+(.+)$/m);
    initialized.title = titleMatch
      ? titleMatch[1]
      : path.basename(mdPath, ".md");
  }

  // Set timestamps
  if (!initialized.created_at) {
    initialized.created_at = now;
  }
  if (!initialized.updated_at) {
    initialized.updated_at = now;
  }

  // Set type-specific defaults
  if (entityType === "spec") {
    if (!initialized.priority && initialized.priority !== 0)
      initialized.priority = 2;
  } else if (entityType === "issue") {
    if (!initialized.status) initialized.status = "open";
    if (!initialized.priority && initialized.priority !== 0)
      initialized.priority = 2;
  }

  return initialized;
}

/**
 * Sync a markdown file to JSONL and SQLite
 * Parses markdown, updates database, optionally exports to JSONL
 */
export async function syncMarkdownToJSONL(
  db: Database.Database,
  mdPath: string,
  options: SyncOptions = {}
): Promise<MarkdownSyncResult> {
  const {
    outputDir = ".sudocode",
    autoExport = true,
    user = "system",
    autoInitialize = true,
    writeBackFrontmatter = true,
  } = options;

  try {
    // Parse markdown file with database validation for cross-references
    const parsed = parseMarkdownFile(mdPath, db, outputDir);
    let { data, content, references } = parsed;

    // Determine entity type from frontmatter or file path
    const entityType = determineEntityType(data, mdPath);
    let entityId = data.id as string | undefined;
    const frontmatterId = entityId; // Keep track of ID from frontmatter for validation

    // Calculate relative file path from outputDir
    const relPath = path.relative(outputDir, mdPath);
    const filePath = relPath.startsWith("..")
      ? path.relative(process.cwd(), mdPath)
      : relPath;

    // For specs, determine which spec this file corresponds to
    // Support two scenarios: rename (ID stays, path changes) and path-based lookup (no ID)
    let existingByPath: Spec | Adr | null = null;
    let existingById: Spec | Adr | null = null;
    if (entityType !== "issue") {
      data.file_path = filePath;
      if (frontmatterId) {
        existingById = documentSyncCase(entityType).get(db, frontmatterId);
      }
      existingByPath = documentSyncCase(entityType).getByFilePath(db, filePath);

      // Scenario 1: Spec exists with this ID
      if (existingById) {
        entityId = existingById.id;

        // Check if file was renamed (ID exists but different path)
        if (existingById.file_path !== filePath) {
          console.log(
            `[sync] File renamed: ${existingById.file_path} → ${filePath}`
          );

          // Check if another spec already exists at new path (conflict)
          if (existingByPath && existingByPath.id !== existingById.id) {
            console.warn(
              `[sync] Warning: File path conflict! Spec ${existingByPath.id} already exists at ${filePath}. Keeping ${existingById.id} and updating path.`
            );
          }
        }
      }
      // Scenario 2: No ID in frontmatter, but spec exists at this path
      else if (existingByPath) {
        entityId = existingByPath.id;
        data.id = entityId;
      }
    }

    // Handle missing frontmatter
    if (!entityId) {
      if (autoInitialize) {
        // Auto-initialize missing fields
        data = initializeFrontmatter(
          db,
          data,
          entityType,
          mdPath,
          outputDir,
          user
        );
        entityId = data.id as string;

        // Write back frontmatter if requested
        if (writeBackFrontmatter) {
          // Filter out internal fields that shouldn't be in markdown frontmatter
          const cleanData = cleanFrontmatterForMarkdown(data);
          updateFrontmatterFile(mdPath, cleanData);
        }
      } else {
        return {
          success: false,
          action: "no-change",
          entityId: "",
          entityType,
          error: "Missing id in frontmatter (auto-initialization disabled)",
        };
      }
    }

    // Check if entity exists by ID
    const existing = getEntity(db, entityId, entityType);

    const isNew = !existing;

    // Get file modification time to use as updated_at timestamp
    // This ensures database timestamp matches when the file was actually modified
    const fileStat = fs.statSync(mdPath);
    const fileModTime = new Date(fileStat.mtimeMs).toISOString();

    if (entityType !== "issue") {
      await syncDocument(
        db,
        entityId,
        entityType,
        data,
        content,
        references,
        isNew,
        user,
        fileModTime
      );
    } else {
      await syncIssue(
        db,
        entityId,
        data,
        content,
        references,
        isNew,
        user,
        fileModTime
      );
    }

    // Auto-export to JSONL if enabled
    if (autoExport) {
      await exportToJSONL(db, {
        outputDir,
      });
    }

    return {
      success: true,
      action: isNew ? "created" : "updated",
      entityId,
      entityType,
    };
  } catch (error) {
    return {
      success: false,
      action: "no-change",
      entityId: "",
      entityType: "spec",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

type EntityFrontmatter = {
  entity: Spec | Issue | Adr;
  frontmatter: ReturnType<typeof entityToFrontmatter>;
};

async function loadEntityFrontmatter(
  db: Database.Database,
  entityId: string,
  entityType: EntityType
): Promise<EntityFrontmatter | null> {
  const entity = getEntity(db, entityId, entityType);
  if (!entity) {
    return null;
  }
  const { getOutgoingRelationships } = await import(
    "./operations/relationships.js"
  );
  const relationships = getOutgoingRelationships(db, entityId, entityType);
  const tags = getTags(db, entityId, entityType);
  return {
    entity,
    frontmatter: entityToFrontmatter(entity, entityType, relationships, tags),
  };
}

function entityNotFound(
  entityId: string,
  entityType: EntityType
): MarkdownSyncResult {
  return {
    success: false,
    action: "no-change",
    entityId,
    entityType,
    error: `${entityType} not found: ${entityId}`,
  };
}

/**
 * Sync from JSONL/SQLite to markdown file
 * Writes full content (frontmatter + body) from database to markdown.
 * Only for callers that changed the body in the database, or whose sync
 * direction established the database as the owner of the body (bulk sync,
 * watcher). A command that changed only metadata (a relationship, status,
 * priority, parent, tags) uses syncEntityMetadataToMarkdown, which keeps the
 * body the file already holds.
 */
export async function syncJSONLToMarkdown(
  db: Database.Database,
  entityId: string,
  entityType: EntityType,
  mdPath: string
): Promise<MarkdownSyncResult> {
  try {
    const loaded = await loadEntityFrontmatter(db, entityId, entityType);
    if (!loaded) {
      return entityNotFound(entityId, entityType);
    }
    const fileExists = fs.existsSync(mdPath);
    writeMarkdownFile(mdPath, loaded.frontmatter, loaded.entity.content || "");
    return {
      success: true,
      action: fileExists ? "updated" : "created",
      entityId,
      entityType,
    };
  } catch (error) {
    return {
      success: false,
      action: "no-change",
      entityId,
      entityType,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * A markdown write that did not happen is an error for the command that asked
 * for it, never a silent success.
 */
export function assertSynced(result: MarkdownSyncResult): void {
  if (!result.success) {
    throw new Error(
      `markdown not updated for ${result.entityType} ${result.entityId}: ${result.error}`
    );
  }
}

/**
 * Rewrite only the frontmatter of an entity's markdown file from the database,
 * keeping the body the file already holds. A metadata change in the database
 * (a relationship, status, priority, parent, tags) never discards an edit to
 * the body that the database has not imported yet. When the file does not
 * exist, the body is the database content.
 */
export async function syncEntityMetadataToMarkdown(
  db: Database.Database,
  entityId: string,
  entityType: EntityType,
  mdPath: string
): Promise<MarkdownSyncResult> {
  try {
    const loaded = await loadEntityFrontmatter(db, entityId, entityType);
    if (!loaded) {
      return entityNotFound(entityId, entityType);
    }
    const fileExists = fs.existsSync(mdPath);
    if (fileExists) {
      fs.writeFileSync(
        mdPath,
        replaceFrontmatter(fs.readFileSync(mdPath, "utf8"), loaded.frontmatter),
        "utf8"
      );
    } else {
      writeMarkdownFile(mdPath, loaded.frontmatter, loaded.entity.content || "");
    }
    return {
      success: true,
      action: fileExists ? "updated" : "created",
      entityId,
      entityType,
    };
  } catch (error) {
    return {
      success: false,
      action: "no-change",
      entityId,
      entityType,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Determine entity type from frontmatter or file path
 */
function determineEntityType(
  frontmatter: Record<string, any>,
  filePath: string
): EntityType {
  const frontmatterType: unknown = frontmatter.entity_type;
  if (frontmatterType !== undefined) {
    try {
      return parseEntityType(frontmatterType);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid entity_type in ${filePath}: ${reason}`);
    }
  }
  const normalized = filePath.replaceAll("\\", "/");
  const row = ENTITY_ROWS.find(
    (candidate) =>
      normalized.includes(`/${candidate.markdownDir}/`) ||
      normalized.includes(`/${candidate.command}-`)
  );
  if (!row) throw new Error(`Cannot infer entity type from ${filePath}`);
  return row.type;
}

async function syncDocument<K extends DocumentEntityType>(
  db: Database.Database,
  id: string,
  entityType: K,
  frontmatter: Record<string, any>,
  content: string,
  references: CrossReference[],
  isNew: boolean,
  user: string,
  fileModTime?: string
): Promise<void> {
  const documentCase = documentSyncCase(entityType);
  const oldDocument = isNew ? null : documentCase.get(db, id);
  const oldContent = oldDocument?.content || "";
  const contentChanged = documentCase.contentChanged(
    oldDocument,
    frontmatter,
    content,
    frontmatter.file_path || ""
  );
  const updatedAt = isNew
    ? fileModTime
    : contentChanged
      ? fileModTime
      : undefined;
  documentCase.sync(
    db,
    id,
    frontmatter,
    content,
    isNew,
    updatedAt
  );

  if (!isNew && oldContent !== content) {
    const feedbackList = listFeedback(db, { to_id: id });
    for (const feedback of feedbackList) {
      const oldAnchor =
        typeof feedback.anchor === "string"
          ? JSON.parse(feedback.anchor)
          : feedback.anchor;
      if (!oldAnchor) continue;
      const newAnchor = relocateFeedbackAnchor(oldContent, content, oldAnchor);
      if (newAnchor) updateFeedback(db, feedback.id, { anchor: newAnchor });
    }
  }

  if (frontmatter.tags && Array.isArray(frontmatter.tags)) {
    setTags(db, id, entityType, frontmatter.tags);
  }
  await syncRelationships(
    db,
    id,
    entityType,
    references,
    frontmatter.relationships,
    user
  );
}

/**
 * Sync issue data to database
 */
async function syncIssue(
  db: Database.Database,
  id: string,
  frontmatter: Record<string, any>,
  content: string,
  references: CrossReference[],
  isNew: boolean,
  user: string,
  fileModTime?: string
): Promise<void> {
  const oldIssue = isNew ? null : getIssue(db, id);

  // Validate and sanitize status from frontmatter
  let status: IssueStatus = "open"; // default
  if (frontmatter.status) {
    if (isValidIssueStatus(frontmatter.status)) {
      status = frontmatter.status as IssueStatus;
    } else {
      console.warn(
        `Warning: Invalid status "${frontmatter.status}" in ${id}, defaulting to "open"`
      );
    }
  }

  const issueData: Partial<Issue> = {
    id,
    title: frontmatter.title || "Untitled",
    content,
    status,
    priority: frontmatter.priority ?? 2,
    assignee: frontmatter.assignee || undefined,
    parent_id: frontmatter.parent_id || undefined,
  };

  if (isNew) {
    createIssue(db, {
      ...issueData,
      updated_at: fileModTime,
    } as any);
  } else {
    // Check if content has actually changed
    const contentChanged =
      oldIssue?.title !== issueData.title ||
      oldIssue?.content !== issueData.content ||
      oldIssue?.status !== issueData.status ||
      oldIssue?.priority !== issueData.priority ||
      oldIssue?.assignee !== issueData.assignee ||
      oldIssue?.parent_id !== issueData.parent_id;

    // Only update timestamp if content actually changed
    // Note: external_links is handled separately via JSONL import, not markdown sync
    updateIssueRow(db, id, {
      ...issueData,
      ...(contentChanged && fileModTime ? { updated_at: fileModTime } : {}),
    } as any);
  }

  // Sync tags
  if (frontmatter.tags && Array.isArray(frontmatter.tags)) {
    setTags(db, id, "issue", frontmatter.tags);
  }

  // Sync relationships from cross-references
  await syncRelationships(
    db,
    id,
    "issue",
    references,
    frontmatter.relationships,
    user
  );
}

/**
 * Sync relationships from cross-references and frontmatter
 * Preserves existing relationships not in frontmatter
 */
async function syncRelationships(
  db: Database.Database,
  entityId: string,
  entityType: EntityType,
  references: CrossReference[],
  frontmatterRels?: Array<{
    // Support both formats:
    // 1. DB format from entityToFrontmatter: { from_id, from_type, to_id, to_type, relationship_type }
    // 2. Simplified format: { target_id, target_type, relationship_type }
    target_id?: string;
    target_type?: string;
    to_id?: string;
    to_type?: string;
    relationship_type: string;
  }>,
  _user: string = "system"
): Promise<void> {
  // Get existing relationships (all outgoing)
  const { getOutgoingRelationships } = await import(
    "./operations/relationships.js"
  );
  const existing = getOutgoingRelationships(db, entityId, entityType);
  const existingSet = new Set(
    existing.map((r) => `${r.relationship_type}:${r.to_type}:${r.to_id}`)
  );

  // Add relationships from cross-references (defaults to 'references' type)
  for (const ref of references) {
    const relType = ref.relationshipType || "references";
    const key = `${relType}:${ref.type}:${ref.id}`;
    if (!existingSet.has(key)) {
      if (!isValidRelationshipType(relType)) {
        throw new Error(`Invalid relationship type in ${entityId}: ${relType}`);
      }
      addRelationshipRow(db, {
        from_id: entityId,
        from_type: entityType,
        to_id: ref.id,
        to_type: ref.type,
        relationship_type: relType,
        metadata: ref.anchor ? JSON.stringify({ anchor: ref.anchor }) : undefined,
      });
    }
  }

  // Add relationships from frontmatter
  // Handle both DB format (to_id/to_type) and simplified format (target_id/target_type)
  if (frontmatterRels && Array.isArray(frontmatterRels)) {
    for (const rel of frontmatterRels) {
      // Support both formats
      const toId = rel.to_id || rel.target_id;
      const rawTargetType: unknown = rel.to_type || rel.target_type;

      if (!toId || !rawTargetType) {
        throw new Error(`Invalid relationship target in ${entityId}`);
      }
      const targetType = parseEntityType(rawTargetType);
      if (!isValidRelationshipType(rel.relationship_type)) {
        throw new Error(
          `Invalid relationship type in ${entityId}: ${rel.relationship_type}`
        );
      }

      const key = `${rel.relationship_type}:${targetType}:${toId}`;
      if (!existingSet.has(key)) {
        addRelationshipRow(db, {
          from_id: entityId,
          from_type: entityType,
          to_id: toId,
          to_type: targetType,
          relationship_type: rel.relationship_type,
        });
      }
    }
  }

  // Note: We preserve existing relationships not in frontmatter
  // This allows relationships added via CLI/UI to persist
}

/**
 * Convert entity to frontmatter object
 */
function entityToFrontmatter(
  entity: Spec | Issue | Adr,
  entityType: EntityType,
  relationships: Array<any>,
  tags: string[]
): Record<string, any> {
  const base: Record<string, any> = {
    id: entity.id,
    title: entity.title,
    created_at: entity.created_at,
  };
  if ("priority" in entity) base.priority = entity.priority;
  if ("parent_id" in entity && entity.parent_id) {
    base.parent_id = entity.parent_id;
  }
  if (entity.archived !== undefined) base.archived = entity.archived;
  if (entity.archived_at) base.archived_at = entity.archived_at;
  if (tags.length > 0) base.tags = tags;
  if (relationships.length > 0) base.relationships = relationships;
  if (entityType !== "issue") return base;

  if (!("status" in entity)) {
    throw new Error(`Issue ${entity.id} has no status`);
  }
  const result: Record<string, any> = { ...base, status: entity.status };
  if (entity.assignee) result.assignee = entity.assignee;
  if (entity.closed_at) result.closed_at = entity.closed_at;
  return result;
}

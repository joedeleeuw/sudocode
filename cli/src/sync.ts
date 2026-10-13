/**
 * Bidirectional sync between Markdown files and JSONL/SQLite
 */

import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import {
  parseMarkdownFile,
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
import { getIssue, createIssue, updateIssue } from "./operations/issues.js";
import {
  addRelationship,
  getOutgoingRelationships,
} from "./operations/relationships.js";
import { getTags, setTags } from "./operations/tags.js";
import { listFeedback, updateFeedback } from "./operations/feedback.js";
import { relocateFeedbackAnchor } from "./operations/feedback-anchors.js";
import { TrackerPublicationError } from "./tracker-publication.js";
import { persistMutation } from "./tracker-mutation.js";
import { generateSpecId, generateIssueId } from "./id-generator.js";
import type { Spec, Issue, IssueStatus } from "@sudocode-ai/types";
import { isValidIssueStatus } from "./validation.js";

export interface MarkdownSyncResult {
  success: boolean;
  action: "created" | "updated" | "no-change";
  entityId: string;
  entityType: "spec" | "issue";
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

/**
 * Remove internal fields that shouldn't be in markdown frontmatter
 * These fields are only for database tracking, not for the markdown files
 */
function cleanFrontmatterForMarkdown(
  data: Record<string, any>,
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
  entityType: "spec" | "issue",
  mdPath: string,
  outputDir: string,
  _user: string,
): Record<string, any> {
  const now = new Date().toISOString();
  const initialized = { ...data };

  if (!initialized.id) {
    const generated =
      entityType === "spec"
        ? generateSpecId(db, outputDir)
        : generateIssueId(db, outputDir);
    initialized.id = generated.id;
    initialized.uuid = generated.uuid;
  }

  if (!initialized.title) {
    const content = fs.readFileSync(mdPath, "utf8");
    const titleMatch = content.match(/^#\s+(.+)$/m);
    initialized.title = titleMatch
      ? titleMatch[1]
      : path.basename(mdPath, ".md");
  }

  if (!initialized.created_at) {
    initialized.created_at = now;
  }
  if (!initialized.updated_at) {
    initialized.updated_at = now;
  }

  if (entityType === "spec") {
    if (!initialized.priority && initialized.priority !== 0)
      initialized.priority = 2;
  } else {
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
  options: SyncOptions = {},
): Promise<MarkdownSyncResult> {
  const {
    outputDir = ".sudocode",
    autoExport = true,
    user = "system",
    autoInitialize = true,
    writeBackFrontmatter = true,
  } = options;

  try {
    const parsed = parseMarkdownFile(mdPath, db, outputDir);
    let { data, content, references } = parsed;

    const entityType = determineEntityType(data, mdPath);
    let entityId = data.id as string | undefined;
    const frontmatterId = entityId; // Keep track of ID from frontmatter for validation

    const relPath = path.relative(outputDir, mdPath);
    const filePath = relPath.startsWith("..")
      ? path.relative(process.cwd(), mdPath)
      : relPath;

    let existingByPath: any = null;
    let existingById: any = null;
    if (entityType === "spec") {
      data.file_path = filePath;

      if (frontmatterId) {
        existingById = getSpec(db, frontmatterId);
      }

      existingByPath = getSpecByFilePath(db, filePath);

      if (existingById) {
        entityId = existingById.id;

        if (existingById.file_path !== filePath) {
          console.log(
            `[sync] File renamed: ${existingById.file_path} → ${filePath}`,
          );

          if (existingByPath && existingByPath.id !== existingById.id) {
            console.warn(
              `[sync] Warning: File path conflict! Spec ${existingByPath.id} already exists at ${filePath}. Keeping ${existingById.id} and updating path.`,
            );
          }
        }
      } else if (existingByPath) {
        entityId = existingByPath.id;
        data.id = entityId;
      } else if (frontmatterId && existingByPath) {
        const correctId = existingByPath.id;
        console.warn(
          `[sync] Warning: ID in frontmatter (${frontmatterId}) differs from existing spec ID (${correctId}) for ${filePath}. Using existing ID.`,
        );
        entityId = correctId;
        data.id = entityId;
      }
    }

    if (!entityId) {
      if (autoInitialize) {
        data = initializeFrontmatter(
          db,
          data,
          entityType,
          mdPath,
          outputDir,
          user,
        );
        entityId = data.id as string;

        if (writeBackFrontmatter) {
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

    const existing =
      entityType === "spec" ? getSpec(db, entityId) : getIssue(db, entityId);

    const isNew = !existing;

    const fileStat = fs.statSync(mdPath);
    const fileModTime = new Date(fileStat.mtimeMs).toISOString();

    const syncEntity = () => {
      if (entityType === "spec") {
        syncSpec(
          db,
          entityId,
          data,
          content,
          references,
          isNew,
          user,
          fileModTime,
        );
      } else {
        syncIssue(
          db,
          entityId,
          data,
          content,
          references,
          isNew,
          user,
          fileModTime,
        );
      }
    };
    if (autoExport) persistMutation(db, outputDir, syncEntity);
    else db.transaction(syncEntity)();

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

/**
 * Sync from JSONL/SQLite to markdown file
 * Writes full content (frontmatter + body) from database to markdown
 */
export async function syncJSONLToMarkdown(
  db: Database.Database,
  entityId: string,
  entityType: "spec" | "issue",
  mdPath: string,
): Promise<MarkdownSyncResult> {
  try {
    const entity =
      entityType === "spec" ? getSpec(db, entityId) : getIssue(db, entityId);

    if (!entity) {
      return {
        success: false,
        action: "no-change",
        entityId,
        entityType,
        error: `${entityType} not found: ${entityId}`,
      };
    }

    const { getOutgoingRelationships } = await import(
      "./operations/relationships.js"
    );
    const relationships = getOutgoingRelationships(db, entityId, entityType);
    const tags = getTags(db, entityId, entityType);

    const frontmatter = entityToFrontmatter(
      entity,
      entityType,
      relationships,
      tags,
    );

    const fileExists = fs.existsSync(mdPath);

    const content = entity.content || "";
    writeMarkdownFile(mdPath, frontmatter, content);

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
  filePath: string,
): "spec" | "issue" {
  if (frontmatter.entity_type === "issue") {
    return "issue";
  }
  if (frontmatter.entity_type === "spec") {
    return "spec";
  }

  if (filePath.includes("/issues/") || filePath.includes("/issue-")) {
    return "issue";
  }
  if (filePath.includes("/specs/") || filePath.includes("/spec-")) {
    return "spec";
  }

  return "spec";
}

/**
 * Sync spec data to database
 */
function syncSpec(
  db: Database.Database,
  id: string,
  frontmatter: Record<string, any>,
  content: string,
  references: CrossReference[],
  isNew: boolean,
  user: string,
  fileModTime?: string,
) {
  const oldSpec = isNew ? null : getSpec(db, id);
  const oldContent = oldSpec?.content || "";

  const specData: Partial<Spec> = {
    id,
    title: frontmatter.title || "Untitled",
    file_path: frontmatter.file_path || "",
    content,
    priority: frontmatter.priority ?? 2,
    parent_id: frontmatter.parent_id || undefined,
  };

  if (isNew) {
    createSpec(db, {
      ...specData,
      updated_at: fileModTime,
    } as any);
  } else {
    const contentChanged =
      oldSpec?.title !== specData.title ||
      oldSpec?.content !== specData.content ||
      oldSpec?.priority !== specData.priority ||
      oldSpec?.parent_id !== specData.parent_id ||
      oldSpec?.file_path !== specData.file_path;

    updateSpec(db, id, {
      ...specData,
      ...(contentChanged && fileModTime ? { updated_at: fileModTime } : {}),
    } as any);

    if (oldContent !== content) {
      const feedbackList = listFeedback(db, { to_id: id });

      if (feedbackList.length > 0) {
        for (const feedback of feedbackList) {
          const oldAnchor =
            typeof feedback.anchor === "string"
              ? JSON.parse(feedback.anchor)
              : feedback.anchor;

          if (!oldAnchor) {
            continue;
          }

          const newAnchor = relocateFeedbackAnchor(
            oldContent,
            content,
            oldAnchor,
          );

          if (newAnchor) {
            updateFeedback(db, feedback.id, {
              anchor: newAnchor,
            });
          }
        }
      }
    }
  }

  if (frontmatter.tags && Array.isArray(frontmatter.tags)) {
    setTags(db, id, "spec", frontmatter.tags);
  }

  syncRelationships(
    db,
    id,
    "spec",
    references,
    frontmatter.relationships,
    user,
  );
}

/**
 * Sync issue data to database
 */
function syncIssue(
  db: Database.Database,
  id: string,
  frontmatter: Record<string, any>,
  content: string,
  references: CrossReference[],
  isNew: boolean,
  user: string,
  fileModTime?: string,
) {
  const oldIssue = isNew ? null : getIssue(db, id);

  let status: IssueStatus = "open"; // default
  if (frontmatter.status) {
    if (isValidIssueStatus(frontmatter.status)) {
      status = frontmatter.status as IssueStatus;
    } else {
      console.warn(
        `Warning: Invalid status "${frontmatter.status}" in ${id}, defaulting to "open"`,
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
    const contentChanged =
      oldIssue?.title !== issueData.title ||
      oldIssue?.content !== issueData.content ||
      oldIssue?.status !== issueData.status ||
      oldIssue?.priority !== issueData.priority ||
      oldIssue?.assignee !== issueData.assignee ||
      oldIssue?.parent_id !== issueData.parent_id;

    updateIssue(db, id, {
      ...issueData,
      ...(contentChanged && fileModTime ? { updated_at: fileModTime } : {}),
    } as any);
  }

  if (frontmatter.tags && Array.isArray(frontmatter.tags)) {
    setTags(db, id, "issue", frontmatter.tags);
  }

  syncRelationships(
    db,
    id,
    "issue",
    references,
    frontmatter.relationships,
    user,
  );
}

/**
 * Sync relationships from cross-references and frontmatter
 * Preserves existing relationships not in frontmatter
 */
function syncRelationships(
  db: Database.Database,
  entityId: string,
  entityType: "spec" | "issue",
  references: CrossReference[],
  frontmatterRels?: Array<{
    target_id?: string;
    target_type?: string;
    to_id?: string;
    to_type?: string;
    relationship_type: string;
  }>,
  _user: string = "system",
) {
  const existing = getOutgoingRelationships(db, entityId, entityType);
  const existingSet = new Set(
    existing.map((r) => `${r.relationship_type}:${r.to_type}:${r.to_id}`),
  );

  for (const ref of references) {
    const relType = ref.relationshipType || "references";
    const key = `${relType}:${ref.type}:${ref.id}`;
    if (!existingSet.has(key)) {
      try {
        addRelationship(db, {
          from_id: entityId,
          from_type: entityType,
          to_id: ref.id,
          to_type: ref.type,
          relationship_type: relType as any,
          metadata: ref.anchor
            ? JSON.stringify({ anchor: ref.anchor })
            : undefined,
        });
      } catch (error) {
        throw new TrackerPublicationError(
          `${entityType}s.jsonl`,
          `${entityId}.relationships`,
          String(error),
        );
      }
    }
  }

  if (frontmatterRels && Array.isArray(frontmatterRels)) {
    for (const rel of frontmatterRels) {
      const toId = rel.to_id || rel.target_id;
      const toType = rel.to_type || rel.target_type;

      if (!toId || !toType) {
        throw new TrackerPublicationError(
          `${entityType}s.jsonl`,
          `${entityId}.relationships.to_id/to_type`,
          "missing relationship target",
        );
      }

      const key = `${rel.relationship_type}:${toType}:${toId}`;
      if (!existingSet.has(key)) {
        try {
          addRelationship(db, {
            from_id: entityId,
            from_type: entityType,
            to_id: toId,
            to_type: toType as "spec" | "issue",
            relationship_type: rel.relationship_type as any,
          });
        } catch (error) {
          throw new TrackerPublicationError(
            `${entityType}s.jsonl`,
            `${entityId}.relationships`,
            String(error),
          );
        }
      }
    }
  }
}

/**
 * Convert entity to frontmatter object
 */
function entityToFrontmatter(
  entity: Spec | Issue,
  entityType: "spec" | "issue",
  relationships: Array<any>,
  tags: string[],
): Record<string, any> {
  const base: Record<string, any> = {
    id: entity.id,
    title: entity.title,
    priority: entity.priority,
    created_at: entity.created_at,
  };

  if (entity.parent_id) base.parent_id = entity.parent_id;
  if (tags.length > 0) base.tags = tags;
  if (relationships.length > 0) base.relationships = relationships;

  if (entityType === "spec") {
    return base;
  } else {
    const issue = entity as Issue;
    const result: Record<string, any> = {
      ...base,
      status: issue.status,
    };

    if (issue.assignee) result.assignee = issue.assignee;
    if (issue.closed_at) result.closed_at = issue.closed_at;

    return result;
  }
}

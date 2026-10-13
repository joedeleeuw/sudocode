import { validateReferences } from "./import-validation.js";
/**
 * Import JSONL data to SQLite with collision resolution
 */

import type Database from "better-sqlite3";
import type { SpecJSONL, IssueJSONL } from "@sudocode-ai/types";
import {
  readJSONLSnapshot,
  isJSONLSynced,
  recordJSONLSync,
} from "./jsonl-sync-state.js";
import {
  listSpecs,
  createSpec,
  updateSpec,
  deleteSpec,
  getSpec,
} from "./operations/specs.js";
import { findExistingEntityFile } from "./filename-generator.js";
import {
  listIssues,
  createIssue,
  updateIssue,
  deleteIssue,
  getIssue,
} from "./operations/issues.js";
import {
  addRelationship,
  removeAllRelationships,
  removeOutgoingRelationships,
} from "./operations/relationships.js";
import { setTags } from "./operations/tags.js";
import {
  createFeedback,
  listFeedback,
  deleteFeedback,
} from "./operations/feedback.js";
import { transaction } from "./operations/transactions.js";
import { specToJSONL, issueToJSONL, groupFeedback } from "./export.js";
import * as path from "path";
import * as fs from "fs";
import { getConfig, isMarkdownFirst } from "./config.js";
import { recoverPublication } from "./tracker-publication.js";

/**
 * Warnings collected during import for non-fatal issues
 */
export interface ImportWarning {
  type: "missing_entity" | "invalid_relationship";
  message: string;
  entityId?: string;
  relationshipFrom?: string;
  relationshipTo?: string;
}

export interface ImportOptions {
  /**
   * Input directory for JSONL files
   */
  inputDir?: string;
  /**
   * Custom file names
   */
  specsFile?: string;
  issuesFile?: string;
  /**
   * Dry run - detect changes but don't apply
   */
  dryRun?: boolean;
  /**
   * Automatically resolve collisions
   */
  resolveCollisions?: boolean;
  /**
   * Path to meta.json for collision logging
   */
  metaPath?: string;
  /**
   * Force update these entity IDs even if timestamp hasn't changed
   * Useful when file watcher detects content hash changes
   */
  forceUpdateIds?: string[];
}

export interface ImportResult {
  specs: {
    added: number;
    updated: number;
    deleted: number;
  };
  issues: {
    added: number;
    updated: number;
    deleted: number;
  };
  collisions: CollisionInfo[];
  warnings?: ImportWarning[];
}

export interface CollisionInfo {
  id: string;
  uuid: string; // UUID of the colliding entity
  type: "spec" | "issue";
  reason: string;
  localContent: string;
  incomingContent: string;
  localCreatedAt?: string; // Created timestamp of local entity
  incomingCreatedAt: string; // Created timestamp of incoming entity
  resolution?: "keep-local" | "use-incoming" | "renumber";
  newId?: string;
}

export interface ChangeDetection {
  added: string[];
  updated: string[];
  deleted: string[];
  unchanged: string[];
}

/**
 * Detect changes between existing and incoming entities
 * Uses UUID as the source of truth for entity identity
 */
export function detectChanges<
  T extends { id: string; uuid: string; updated_at: string },
>(
  existing: T[],
  incoming: T[],
  forceUpdateIds: string[] = [],
): ChangeDetection {
  const existingByUUID = new Map(existing.map((e) => [e.uuid, e]));
  const incomingUUIDs = new Set(incoming.map((e) => e.uuid));
  const forceUpdateSet = new Set(forceUpdateIds);

  const added = incoming
    .filter((e) => !existingByUUID.has(e.uuid))
    .map((e) => e.id);

  const deleted = existing
    .filter((e) => !incomingUUIDs.has(e.uuid))
    .map((e) => e.id);

  const updated: string[] = [];
  const unchanged: string[] = [];

  for (const inc of incoming) {
    const ex = existingByUUID.get(inc.uuid);
    if (ex) {
      if (forceUpdateSet.has(inc.id) || hasChanged(ex, inc)) {
        updated.push(inc.id);
      } else {
        unchanged.push(inc.id);
      }
    }
  }

  return { added, updated, deleted, unchanged };
}

/**
 * Serialize an entity in a canonical form for content comparison: object keys
 * sorted, array order ignored (relationships, tags, feedback and external
 * links are sets), and null/undefined fields dropped (a missing key and an
 * explicit null carry the same meaning in JSONL).
 */
function canonicalContent(value: unknown): string {
  if (Array.isArray(value)) {
    const items = value.map(canonicalContent).sort();
    return `[${items.join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(
        ([, fieldValue]) => fieldValue !== undefined && fieldValue !== null,
      )
      .map(([key, fieldValue]) => [key, canonicalContent(fieldValue)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, serialized]) => `${JSON.stringify(key)}:${serialized}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/**
 * Check if an entity has changed by comparing full canonical content, not
 * updated_at: a JSONL edit or merge that leaves the timestamp untouched is
 * still a change the database must import.
 */
function hasChanged<T>(existing: T, incoming: T): boolean {
  return canonicalContent(existing) !== canonicalContent(incoming);
}

/**
 * Detect ID collisions (same ID, different UUID)
 * UUIDs are the source of truth for entity identity
 */
export function detectCollisions<
  T extends { id: string; uuid: string; title: string; created_at: string },
>(existing: T[], incoming: T[]): CollisionInfo[] {
  const collisions: CollisionInfo[] = [];
  const existingMap = new Map(existing.map((e) => [e.id, e]));

  for (const inc of incoming) {
    const ex = existingMap.get(inc.id);
    if (ex && ex.uuid !== inc.uuid) {
      collisions.push({
        id: inc.id,
        uuid: inc.uuid, // UUID of the incoming entity
        type: "spec", // Will be set correctly by caller
        reason: "Same ID but different UUID (different entities)",
        localContent: ex.title,
        incomingContent: inc.title,
        localCreatedAt: ex.created_at,
        incomingCreatedAt: inc.created_at,
      });
    }
  }

  const incomingByID = new Map<string, T[]>();
  for (const inc of incoming) {
    const existing = incomingByID.get(inc.id) || [];
    existing.push(inc);
    incomingByID.set(inc.id, existing);
  }

  for (const [id, entities] of incomingByID.entries()) {
    if (entities.length > 1) {
      const uniqueUUIDs = new Set(entities.map((e) => e.uuid));
      if (uniqueUUIDs.size > 1) {
        for (let i = 1; i < entities.length; i++) {
          collisions.push({
            id: entities[i].id,
            uuid: entities[i].uuid, // UUID of the colliding entity
            type: "spec", // Will be set correctly by caller
            reason: "Duplicate ID in incoming data with different UUID",
            localContent: entities[0].title,
            incomingContent: entities[i].title,
            localCreatedAt: entities[0].created_at,
            incomingCreatedAt: entities[i].created_at,
          });
        }
      }
    }
  }

  return collisions;
}

/**
 * Count references to an entity ID in content fields
 */
export function countReferences(
  db: Database.Database,
  entityId: string,
  entityType: "spec" | "issue",
): number {
  let count = 0;

  const specs = listSpecs(db);
  for (const spec of specs) {
    const regex = new RegExp(`\\b${entityId}\\b`, "g");
    const matches = spec.content.match(regex);
    if (matches) {
      count += matches.length;
    }
  }

  const issues = listIssues(db);
  for (const issue of issues) {
    const regex = new RegExp(`\\b${entityId}\\b`, "g");
    const contentMatches = issue.content.match(regex);
    if (contentMatches) count += contentMatches.length;
  }

  return count;
}

/**
 * Resolve collisions using timestamp-based deterministic strategy
 *
 * The entity with the NEWER (more recent) created_at timestamp logically
 * should be renumbered, while the OLDER entity keeps the original ID.
 *
 * For practical reasons (entities already in DB can't be easily renamed),
 * incoming entities are always the ones that get new IDs. However, we
 * deterministically decide which UUID gets which new ID based on timestamps.
 */
export function resolveCollisions(
  db: Database.Database,
  collisions: CollisionInfo[],
): CollisionInfo[] {
  const resolved: CollisionInfo[] = [];
  const uuidToNewId = new Map<string, string>();

  for (const collision of collisions) {
    let incomingIsNewer = true;

    if (collision.localCreatedAt) {
      const localTime = new Date(collision.localCreatedAt).getTime();
      const incomingTime = new Date(collision.incomingCreatedAt).getTime();

      if (incomingTime > localTime) {
        incomingIsNewer = true; // Incoming is newer
      } else if (localTime > incomingTime) {
        incomingIsNewer = false; // Local is newer
      } else {
        incomingIsNewer = collision.uuid > collision.localContent;
      }
    }

    let newId = uuidToNewId.get(collision.uuid);
    if (!newId) {
      newId = generateNewId(db, collision.id, collision.type);
      uuidToNewId.set(collision.uuid, newId);
    }

    resolved.push({
      ...collision,
      resolution: "renumber", // Incoming always gets renumbered
      newId,
      ...(incomingIsNewer && {
        note: "incoming is newer - correctly renumbered",
      }),
      ...(!incomingIsNewer && {
        note: "local is newer - incoming (older) being renumbered",
      }),
    });
  }

  return resolved;
}

/**
 * Generate a new unique ID
 */
function generateNewId(
  db: Database.Database,
  oldId: string,
  type: "spec" | "issue",
): string {
  const match = oldId.match(/^([a-z]+-)?(\d+)$/i);
  if (!match) {
    return `${type}-${Date.now()}`;
  }

  const prefix = match[1] || `${type}-`;
  let num = parseInt(match[2], 10);

  let newId = `${prefix}${num + 1000}`;
  let attempts = 0;

  while (attempts < 1000) {
    const exists =
      type === "spec"
        ? getSpec(db, newId) !== null
        : getIssue(db, newId) !== null;

    if (!exists) {
      return newId;
    }

    num++;
    newId = `${prefix}${num + 1000}`;
    attempts++;
  }

  return `${prefix}${Date.now()}`;
}

/**
 * Update text references when an ID is renumbered
 */
export function updateTextReferences(
  db: Database.Database,
  oldId: string,
  newId: string,
): number {
  let updatedCount = 0;

  const specs = listSpecs(db);
  for (const spec of specs) {
    const regex = new RegExp(`\\b${oldId}\\b`, "g");
    if (regex.test(spec.content)) {
      const newContent = spec.content.replace(regex, newId);
      updateSpec(db, spec.id, {
        content: newContent,
      });
      updatedCount++;
    }
  }

  const issues = listIssues(db);
  for (const issue of issues) {
    const regex = new RegExp(`\\b${oldId}\\b`, "g");
    let updated = false;
    let newContent = issue.content;

    if (regex.test(issue.content)) {
      newContent = issue.content.replace(regex, newId);
      updated = true;
    }

    if (updated) {
      updateIssue(db, issue.id, {
        content: newContent,
      });
      updatedCount++;
    }
  }

  return updatedCount;
}

/**
 * Import specs from JSONL
 */
export function importSpecs(
  db: Database.Database,
  specs: SpecJSONL[],
  changes: ChangeDetection,
  dryRun: boolean = false,
  skipRelationships: boolean = false,
): { added: number; updated: number; deleted: number } {
  if (dryRun) {
    return {
      added: changes.added.length,
      updated: changes.updated.length,
      deleted: changes.deleted.length,
    };
  }

  let added = 0;
  let updated = 0;
  let deleted = 0;

  const specsWithParents: SpecJSONL[] = [];
  for (const id of changes.added) {
    const spec = specs.find((s) => s.id === id);
    if (spec) {
      createSpec(db, {
        id: spec.id,
        uuid: spec.uuid,
        title: spec.title,
        file_path: spec.file_path,
        content: spec.content,
        priority: spec.priority,
        archived: spec.archived,
        archived_at: spec.archived_at,
        created_at: spec.created_at,
        updated_at: spec.updated_at,
        external_links:
          spec.external_links && spec.external_links.length > 0
            ? JSON.stringify(spec.external_links)
            : null,
      });

      setTags(db, spec.id, "spec", spec.tags || []);
      added++;

      if (spec.parent_id) {
        specsWithParents.push(spec);
      }
    }
  }

  for (const spec of specsWithParents) {
    updateSpec(db, spec.id, {
      parent_id: spec.parent_id,
      updated_at: spec.updated_at,
    });
  }

  if (!skipRelationships) {
    for (const id of changes.added) {
      const spec = specs.find((s) => s.id === id);
      if (spec) {
        if (spec.relationships && spec.relationships.length > 0) {
          for (const rel of spec.relationships) {
            addRelationship(db, {
              from_id: rel.from,
              from_type: rel.from_type,
              to_id: rel.to,
              to_type: rel.to_type,
              relationship_type: rel.type,
            });
          }
        }
      }
    }
  }

  for (const id of changes.updated) {
    const spec = specs.find((s) => s.id === id);
    if (spec) {
      updateSpec(db, spec.id, {
        title: spec.title,
        file_path: spec.file_path,
        content: spec.content,
        priority: spec.priority,
        parent_id: spec.parent_id,
        archived: spec.archived,
        archived_at: spec.archived_at,
        updated_at: spec.updated_at,
        external_links:
          spec.external_links && spec.external_links.length > 0
            ? JSON.stringify(spec.external_links)
            : null,
      });
      setTags(db, spec.id, "spec", spec.tags || []);
      updated++;
    }
  }

  if (!skipRelationships) {
    for (const id of changes.updated) {
      const spec = specs.find((s) => s.id === id);
      if (spec) {
        removeOutgoingRelationships(db, spec.id, "spec");
        for (const rel of spec.relationships || []) {
          addRelationship(db, {
            from_id: rel.from,
            from_type: rel.from_type,
            to_id: rel.to,
            to_type: rel.to_type,
            relationship_type: rel.type,
          });
        }
      }
    }
  }

  for (const id of changes.deleted) {
    deleteSpec(db, id);
    deleted++;
  }

  return { added, updated, deleted };
}

/**
 * Import issues from JSONL
 */
export function importIssues(
  db: Database.Database,
  issues: IssueJSONL[],
  changes: ChangeDetection,
  dryRun: boolean = false,
  skipRelationships: boolean = false,
): { added: number; updated: number; deleted: number } {
  if (dryRun) {
    return {
      added: changes.added.length,
      updated: changes.updated.length,
      deleted: changes.deleted.length,
    };
  }

  let added = 0;
  let updated = 0;
  let deleted = 0;

  const issuesWithParents: IssueJSONL[] = [];
  for (const id of changes.added) {
    const issue = issues.find((i) => i.id === id);
    if (issue) {
      createIssue(db, {
        id: issue.id,
        uuid: issue.uuid,
        title: issue.title,
        content: issue.content,
        status: issue.status,
        priority: issue.priority,
        assignee: issue.assignee,
        archived: issue.archived,
        archived_at: issue.archived_at,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
        closed_at: issue.closed_at,
        external_links:
          issue.external_links && issue.external_links.length > 0
            ? JSON.stringify(issue.external_links)
            : null,
      });
      setTags(db, issue.id, "issue", issue.tags || []);
      added++;

      if (issue.parent_id) {
        issuesWithParents.push(issue);
      }
    }
  }

  for (const issue of issuesWithParents) {
    updateIssue(db, issue.id, {
      parent_id: issue.parent_id,
      updated_at: issue.updated_at,
    });
  }

  if (!skipRelationships) {
    for (const id of changes.added) {
      const issue = issues.find((i) => i.id === id);
      if (issue) {
        for (const rel of issue.relationships || []) {
          addRelationship(db, {
            from_id: rel.from,
            from_type: rel.from_type,
            to_id: rel.to,
            to_type: rel.to_type,
            relationship_type: rel.type,
          });
        }
      }
    }
  }

  for (const id of changes.updated) {
    const issue = issues.find((i) => i.id === id);
    if (issue) {
      updateIssue(db, issue.id, {
        title: issue.title,
        content: issue.content,
        status: issue.status,
        priority: issue.priority,
        assignee: issue.assignee,
        parent_id: issue.parent_id,
        archived: issue.archived,
        archived_at: issue.archived_at,
        updated_at: issue.updated_at,
        closed_at: issue.closed_at,
        external_links:
          issue.external_links && issue.external_links.length > 0
            ? JSON.stringify(issue.external_links)
            : null,
      });
      setTags(db, issue.id, "issue", issue.tags || []);
      updated++;
    }
  }

  if (!skipRelationships) {
    for (const id of changes.updated) {
      const issue = issues.find((i) => i.id === id);
      if (issue) {
        removeOutgoingRelationships(db, issue.id, "issue");
        for (const rel of issue.relationships || []) {
          addRelationship(db, {
            from_id: rel.from,
            from_type: rel.from_type,
            to_id: rel.to,
            to_type: rel.to_type,
            relationship_type: rel.type,
          });
        }
      }
    }
  }

  for (const id of changes.deleted) {
    deleteIssue(db, id);
    deleted++;
  }

  return { added, updated, deleted };
}

/**
 * Import both specs and issues from JSONL files
 */
export function importFromJSONL(
  db: Database.Database,
  options: ImportOptions = {},
): ImportResult {
  if (!db.inTransaction)
    return db.transaction(() => importFromJSONL(db, options)).immediate();
  recoverPublication(db, options.inputDir ?? ".sudocode");
  const {
    inputDir = ".sudocode",
    specsFile = "specs.jsonl",
    issuesFile = "issues.jsonl",
    dryRun = false,
    resolveCollisions: shouldResolve = true,
    forceUpdateIds = [],
  } = options;

  const config = getConfig(inputDir);
  if (isMarkdownFirst(config)) {
    console.warn(
      "[import] Warning: Markdown is configured as source of truth (sourceOfTruth = 'markdown').",
    );
    console.warn(
      "[import] JSONL import may override changes. Consider using 'sudocode sync --from-markdown' instead.",
    );
  }

  const specsSnapshot = readJSONLSnapshot<SpecJSONL>(
    path.join(inputDir, specsFile),
  );
  const issuesSnapshot = readJSONLSnapshot<IssueJSONL>(
    path.join(inputDir, issuesFile),
  );
  const incomingSpecs = specsSnapshot.entities;
  const incomingIssues = issuesSnapshot.entities;
  validateReferences(specsSnapshot, issuesSnapshot);

  const feedbackByOwner = groupFeedback(db);
  const existingSpecs = listSpecs(db).map((spec) =>
    specToJSONL(db, spec, undefined, feedbackByOwner),
  );
  const existingIssues = listIssues(db).map((issue) =>
    issueToJSONL(db, issue, undefined, feedbackByOwner),
  );

  const specCollisions = detectCollisions(existingSpecs, incomingSpecs);
  const issueCollisions = detectCollisions(existingIssues, incomingIssues);

  const allCollisions = [
    ...specCollisions.map((c) => ({ ...c, type: "spec" as const })),
    ...issueCollisions.map((c) => ({ ...c, type: "issue" as const })),
  ];

  let resolvedCollisions: CollisionInfo[] = [];
  if (shouldResolve && allCollisions.length > 0) {
    resolvedCollisions = resolveCollisions(db, allCollisions);

    for (const collision of resolvedCollisions) {
      if (collision.resolution === "renumber" && collision.newId) {
        const oldId = collision.id;
        const newId = collision.newId;

        if (collision.type === "spec") {
          const spec = incomingSpecs.find(
            (s) => s.id === oldId && s.uuid === collision.uuid,
          );
          if (spec) {
            spec.id = newId;
          }

          for (const issue of incomingIssues) {
            if (issue.feedback) {
              for (const fb of issue.feedback) {
                const feedbackToId = fb.to_id;
                if (feedbackToId === oldId) {
                  fb.to_id = newId;
                }
              }
            }
          }
        } else if (collision.type === "issue") {
          const issue = incomingIssues.find(
            (i) => i.id === oldId && i.uuid === collision.uuid,
          );
          if (issue) {
            issue.id = newId;

            if (issue.feedback) {
              for (const fb of issue.feedback) {
                if (fb.from_id) fb.from_id = newId;
              }
            }
          }

          for (const otherIssue of incomingIssues) {
            if (otherIssue.feedback) {
              for (const fb of otherIssue.feedback) {
                const feedbackFromId = fb.from_id;
                if (feedbackFromId === oldId) {
                  if (fb.from_id) fb.from_id = newId;
                }
              }
            }
          }
        }
      }
    }
  }

  const specChanges = detectChanges(
    existingSpecs,
    incomingSpecs,
    forceUpdateIds,
  );
  const issueChanges = detectChanges(
    existingIssues,
    incomingIssues,
    forceUpdateIds,
  );

  const markdownFilesToDelete: string[] = [];
  if (!dryRun) {
    for (const id of specChanges.deleted) {
      const spec = getSpec(db, id);
      if (spec && spec.file_path) {
        markdownFilesToDelete.push(path.join(inputDir, spec.file_path));
      }
    }
    for (const id of issueChanges.deleted) {
      const issuesDir = path.join(inputDir, "issues");
      const existing = findExistingEntityFile(id, issuesDir);
      if (existing) {
        markdownFilesToDelete.push(existing);
      }
    }
  }

  const result: ImportResult = {
    specs: { added: 0, updated: 0, deleted: 0 },
    issues: { added: 0, updated: 0, deleted: 0 },
    collisions:
      resolvedCollisions.length > 0 ? resolvedCollisions : allCollisions,
    warnings: [],
  };

  const addImportedRelationship = (rel: SpecJSONL["relationships"][number]) => {
    addRelationship(db, {
      from_id: rel.from,
      from_type: rel.from_type,
      to_id: rel.to,
      to_type: rel.to_type,
      relationship_type: rel.type,
    });
  };

  if (!dryRun) {
    transaction(db, () => {
      result.specs = importSpecs(db, incomingSpecs, specChanges, dryRun, true);
      result.issues = importIssues(
        db,
        incomingIssues,
        issueChanges,
        dryRun,
        true,
      );

      for (const id of specChanges.added) {
        const spec = incomingSpecs.find((s) => s.id === id);
        if (spec && spec.relationships && spec.relationships.length > 0) {
          for (const rel of spec.relationships) {
            addImportedRelationship(rel);
          }
        }
      }

      for (const id of specChanges.updated) {
        const spec = incomingSpecs.find((s) => s.id === id);
        if (spec) {
          removeOutgoingRelationships(db, spec.id, "spec");
          for (const rel of spec.relationships || []) {
            addImportedRelationship(rel);
          }
        }
      }

      for (const id of issueChanges.added) {
        const issue = incomingIssues.find((i) => i.id === id);
        if (issue && issue.relationships && issue.relationships.length > 0) {
          for (const rel of issue.relationships) {
            addImportedRelationship(rel);
          }
        }
      }

      for (const id of issueChanges.updated) {
        const issue = incomingIssues.find((i) => i.id === id);
        if (issue) {
          removeOutgoingRelationships(db, issue.id, "issue");
          for (const rel of issue.relationships || []) {
            addImportedRelationship(rel);
          }
        }
      }

      for (const feedback of listFeedback(db)) deleteFeedback(db, feedback.id);
      for (const entity of [...incomingSpecs, ...incomingIssues]) {
        for (const feedback of entity.feedback ?? [])
          createFeedback(db, feedback);
      }

      if (resolvedCollisions.length === 0) {
        recordJSONLSync(db, specsSnapshot);
        recordJSONLSync(db, issuesSnapshot);
      }
    });

    for (const filePath of markdownFilesToDelete) {
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (err) {
          console.warn(`Failed to delete markdown file: ${filePath}`, err);
        }
      }
    }
  } else {
    result.specs = importSpecs(db, incomingSpecs, specChanges, dryRun);
    result.issues = importIssues(db, incomingIssues, issueChanges, dryRun);
  }

  if (result.warnings && result.warnings.length > 0) {
    console.warn(
      `[Import] ${result.warnings.length} relationship(s) skipped due to missing entities:`,
    );
    for (const warning of result.warnings) {
      console.warn(`  - ${warning.message}`);
    }
  }

  return result;
}

/**
 * Import the tracked JSONL into the database unless the database already holds
 * exactly its current content. Covers a newly created cache.db (fresh clone or
 * worktree) and JSONL changed underneath the database by git. Must run before
 * anything reads or writes the database; returns null when nothing was stale.
 */
export function importJSONLIfStale(
  db: Database.Database,
  sudocodeDir: string,
): ImportResult | null {
  if (!db.inTransaction)
    return db
      .transaction(() => importJSONLIfStale(db, sudocodeDir))
      .immediate();
  recoverPublication(db, sudocodeDir);
  const specs = readJSONLSnapshot(path.join(sudocodeDir, "specs.jsonl"));
  const issues = readJSONLSnapshot(path.join(sudocodeDir, "issues.jsonl"));
  if (isJSONLSynced(db, specs) && isJSONLSynced(db, issues)) {
    return null;
  }

  const held = [
    { kind: "specs", snapshot: specs, count: listSpecs(db).length },
    { kind: "issues", snapshot: issues, count: listIssues(db).length },
  ];
  for (const { kind, snapshot, count } of held) {
    if (snapshot.sha256 === null && count > 0) {
      throw new Error(
        `${snapshot.filePath} is missing but the database holds ${count} ${kind}. ` +
          `Restore the file (git checkout -- ${snapshot.filePath}), or delete .sudocode/cache.db to rebuild the database from the JSONL that exists.`,
      );
    }
  }

  return importFromJSONL(db, { inputDir: sudocodeDir });
}

/**
 * Import JSONL data to SQLite with collision resolution
 */

import type Database from "better-sqlite3";
import type { AdrJSONL, EntityType, RelationshipJSONL, SpecJSONL, IssueJSONL } from "@sudocode-ai/types";
import {
  ENTITY_ROWS,
  getEntityRow,
  type Entity,
  type EntitySnapshot,
  type EntitySnapshots,
} from "@sudocode-ai/types/entities";
import { readPersistedSnapshot } from "./snapshot.js";
import {
  remapIdentityReferences,
  resolveIdentityCollisions,
  type IdentityCollision,
  type IdentityRename,
} from "./identity-collisions.js";
import {
  listSpecs,
  createSpec,
  updateSpec,
  deleteSpec,
  getSpec,
} from "./operations/specs.js";
import {
  listAdrs,
  createAdr,
  updateAdr,
  deleteAdr,
  getAdr,
} from "./operations/adrs.js";
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
  EntityNotFoundError,
  removeOutgoingRelationships,
} from "./operations/relationships.js";
import { setTags } from "./operations/tags.js";
import { createFeedback } from "./operations/feedback.js";
import { transaction } from "./operations/transactions.js";
import * as path from "path";
import * as fs from "fs";
import { getConfig, isMarkdownFirst } from "./config.js";

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
  adrsFile?: string;
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
  adrs: {
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
  type: EntityType;
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
  Existing extends { id: string; uuid: string; updated_at: string },
  Incoming extends { id: string; uuid: string; updated_at: string },
>(existing: Existing[], incoming: Incoming[], forceUpdateIds: string[] = []): ChangeDetection {
  // Map by UUID (the true identity)
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
      // Same entity (same UUID), check if content changed or force update requested
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
 * Check if an entity has changed
 */
function hasChanged(
  existing: { updated_at: string },
  incoming: { updated_at: string }
): boolean {
  // Simple comparison based on updated_at timestamp
  return existing.updated_at !== incoming.updated_at;
}

/**
 * Detect ID collisions (same ID, different UUID)
 * UUIDs are the source of truth for entity identity
 */
export function detectCollisions<
  Existing extends { id: string; uuid: string; title?: string; created_at: string },
  Incoming extends { id: string; uuid: string; title: string; created_at: string },
>(existing: Existing[], incoming: Incoming[]): CollisionInfo[] {
  const collisions: CollisionInfo[] = [];
  const existingMap = new Map(existing.map((e) => [e.id, e]));

  // First, detect collisions between existing and incoming
  for (const inc of incoming) {
    const ex = existingMap.get(inc.id);
    // Collision only if same ID but different UUID (different entities)
    if (ex && ex.uuid !== inc.uuid) {
      collisions.push({
        id: inc.id,
        uuid: inc.uuid, // UUID of the incoming entity
        type: "spec", // Will be set correctly by caller
        reason: "Same ID but different UUID (different entities)",
        localContent: ex.title ?? "",
        incomingContent: inc.title,
        localCreatedAt: ex.created_at,
        incomingCreatedAt: inc.created_at,
      });
    }
  }

  // Second, detect collisions within incoming data itself (duplicates)
  const incomingByID = new Map<string, Incoming[]>();
  for (const inc of incoming) {
    const existing = incomingByID.get(inc.id) || [];
    existing.push(inc);
    incomingByID.set(inc.id, existing);
  }

  for (const [id, entities] of incomingByID.entries()) {
    if (entities.length > 1) {
      // Multiple entities with same ID in incoming data
      // Check if they have different UUIDs (real collision) vs same UUID (duplicate entry)
      const uniqueUUIDs = new Set(entities.map((e) => e.uuid));
      if (uniqueUUIDs.size > 1) {
        // Different UUIDs = real collision within incoming data
        // We'll keep the first one and mark the rest as collisions
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
  entityType: EntityType
): number {
  let count = 0;

  // Count in specs
  const specs = listSpecs(db);
  for (const spec of specs) {
    const regex = new RegExp(`\\b${entityId}\\b`, "g");
    const matches = spec.content.match(regex);
    if (matches) {
      count += matches.length;
    }
  }

  // Count in issues
  const issues = listIssues(db);
  for (const issue of issues) {
    const regex = new RegExp(`\\b${entityId}\\b`, "g");
    const contentMatches = issue.content.match(regex);
    if (contentMatches) count += contentMatches.length;
  }

  return count;
}


/**
 * Update text references when an ID is renumbered
 */
export function updateTextReferences(
  db: Database.Database,
  oldId: string,
  newId: string
): number {
  let updatedCount = 0;

  // Update specs
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

  // Update issues
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
  dryRun: boolean = false
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

  // Add new specs (first pass: without parent_id to handle out-of-order parents)
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
        // Skip parent_id in first pass - will be set in second pass
        archived: spec.archived,
        archived_at: spec.archived_at,
        created_at: spec.created_at,
        updated_at: spec.updated_at,
        // Pass null when JSONL doesn't have external_links, so SQLite gets cleared
        // (undefined would skip the update, causing oscillation with export)
        external_links: spec.external_links && spec.external_links.length > 0
          ? JSON.stringify(spec.external_links)
          : null,
      });

      // Add tags
      setTags(db, spec.id, "spec", spec.tags || []);
      added++;

      // Track specs with parent_id for second pass
      if (spec.parent_id) {
        specsWithParents.push(spec);
      }
    }
  }

  // Second pass: set parent_id for newly added specs (now all parents exist)
  // Preserve updated_at to avoid clobbering timestamps set in pass 1
  for (const spec of specsWithParents) {
    updateSpec(db, spec.id, {
      parent_id: spec.parent_id,
      updated_at: spec.updated_at,
    });
  }

  // Update existing specs
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
        // Pass null when JSONL doesn't have external_links, so SQLite gets cleared
        // (undefined would skip the update, causing oscillation with export)
        external_links: spec.external_links && spec.external_links.length > 0
          ? JSON.stringify(spec.external_links)
          : null,
      });
      setTags(db, spec.id, "spec", spec.tags || []);
      updated++;
    }
  }

  // Delete removed specs
  for (const id of changes.deleted) {
    deleteSpec(db, id);
    deleted++;
  }

  return { added, updated, deleted };
}

export function importAdrs(
  db: Database.Database,
  adrs: AdrJSONL[],
  changes: ChangeDetection,
  dryRun: boolean = false
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
  for (const id of changes.added) {
    const adr = adrs.find((candidate) => candidate.id === id);
    if (!adr) continue;
    createAdr(db, {
      id: adr.id,
      uuid: adr.uuid,
      title: adr.title,
      file_path: adr.file_path,
      content: adr.content,
      archived: adr.archived,
      archived_at: adr.archived_at,
      created_at: adr.created_at,
      updated_at: adr.updated_at,
      external_links: adr.external_links?.length
        ? JSON.stringify(adr.external_links)
        : null,
    });
    setTags(db, adr.id, "adr", adr.tags);
    added++;
  }

  for (const id of changes.updated) {
    const adr = adrs.find((candidate) => candidate.id === id);
    if (!adr) continue;
    updateAdr(db, id, {
      title: adr.title,
      file_path: adr.file_path,
      content: adr.content,
      archived: adr.archived,
      archived_at: adr.archived_at,
      updated_at: adr.updated_at,
      external_links: adr.external_links?.length
        ? JSON.stringify(adr.external_links)
        : null,
    });
    setTags(db, id, "adr", adr.tags);
    updated++;
  }

  for (const id of changes.deleted) {
    deleteAdr(db, id);
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
  dryRun: boolean = false
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

  // Add new issues (first pass: without parent_id to handle out-of-order parents)
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
        // Skip parent_id in first pass - will be set in second pass
        archived: issue.archived,
        archived_at: issue.archived_at,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
        closed_at: issue.closed_at,
        // Pass null when JSONL doesn't have external_links, so SQLite gets cleared
        // (undefined would skip the update, causing oscillation with export)
        external_links: issue.external_links && issue.external_links.length > 0
          ? JSON.stringify(issue.external_links)
          : null,
      });
      setTags(db, issue.id, "issue", issue.tags || []);
      added++;

      // Track issues with parent_id for second pass
      if (issue.parent_id) {
        issuesWithParents.push(issue);
      }
    }
  }

  // Second pass: set parent_id for newly added issues (now all parents exist)
  // Preserve updated_at to avoid clobbering timestamps set in pass 1
  for (const issue of issuesWithParents) {
    updateIssue(db, issue.id, {
      parent_id: issue.parent_id,
      updated_at: issue.updated_at,
    });
  }

  // Update existing issues
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
        // Pass null when JSONL doesn't have external_links, so SQLite gets cleared
        // (undefined would skip the update, causing oscillation with export)
        external_links: issue.external_links && issue.external_links.length > 0
          ? JSON.stringify(issue.external_links)
          : null,
      });
      setTags(db, issue.id, "issue", issue.tags || []);
      updated++;
    }
  }

  // Delete removed issues
  for (const id of changes.deleted) {
    deleteIssue(db, id);
    deleted++;
  }
  return { added, updated, deleted };
}

interface ImportCounts {
  added: number;
  updated: number;
  deleted: number;
}

interface EntityImportCase<K extends EntityType> {
  list(db: Database.Database): Entity<K>[];
  import(
    db: Database.Database,
    entities: EntitySnapshot<K>[],
    changes: ChangeDetection,
    dryRun: boolean
  ): ImportCounts;
  deletedMarkdownPath(db: Database.Database, inputDir: string, id: string): string | null;
}

const IMPORT_CASES = {
  spec: {
    list: listSpecs,
    import: importSpecs,
    deletedMarkdownPath(db, inputDir, id) {
      const spec = getSpec(db, id);
      return spec ? path.join(inputDir, spec.file_path) : null;
    },
  },
  issue: {
    list: listIssues,
    import: importIssues,
    deletedMarkdownPath(_db, inputDir, id) {
      return findExistingEntityFile(
        id,
        path.join(inputDir, getEntityRow("issue").markdownDir)
      );
    },
  },
  adr: {
    list: listAdrs,
    import: importAdrs,
    deletedMarkdownPath(db, inputDir, id) {
      const adr = getAdr(db, id);
      return adr ? path.join(inputDir, adr.file_path) : null;
    },
  },
} satisfies { [K in EntityType]: EntityImportCase<K> };

type ExistingEntities = { [K in EntityType]: Entity<K>[] };
type ChangeMap = Record<EntityType, ChangeDetection>;
type CountMap = Record<EntityType, ImportCounts>;

function existingEntitySnapshot(db: Database.Database): ExistingEntities {
  return {
    spec: IMPORT_CASES.spec.list(db),
    issue: IMPORT_CASES.issue.list(db),
    adr: IMPORT_CASES.adr.list(db),
  };
}

function applySnapshotRenames(snapshot: EntitySnapshots, renames: IdentityRename[]): void {
  for (const row of ENTITY_ROWS) {
    snapshot[row.type] = remapIdentityReferences(snapshot[row.type], renames);
  }
}

function toCollisionInfo(collision: IdentityCollision): CollisionInfo {
  return {
    id: collision.oldId,
    uuid: collision.uuid,
    type: collision.entityType,
    reason: collision.reason,
    localContent: collision.localTitle ?? "",
    incomingContent: collision.incomingTitle ?? "",
    localCreatedAt: collision.localCreatedAt,
    incomingCreatedAt: collision.incomingCreatedAt ?? "",
    resolution: "renumber",
    newId: collision.newId,
  };
}

function collectMarkdownDeletions(
  db: Database.Database,
  inputDir: string,
  changes: ChangeMap
): string[] {
  const files: string[] = [];
  for (const row of ENTITY_ROWS) {
    for (const id of changes[row.type].deleted) {
      const filePath = IMPORT_CASES[row.type].deletedMarkdownPath(db, inputDir, id);
      if (filePath) files.push(filePath);
    }
  }
  return files;
}

function importSnapshotFeedback(db: Database.Database, snapshot: EntitySnapshots): void {
  db.prepare("DELETE FROM issue_feedback").run();
  for (const row of ENTITY_ROWS) {
    for (const entity of snapshot[row.type]) {
      for (const feedback of entity.feedback ?? []) {
        createFeedback(db, feedback);
      }
    }
  }
}

function importCaseRelationships(
  db: Database.Database,
  entityType: EntityType,
  entities: EntitySnapshot[],
  caseChanges: ChangeDetection,
  warnings: ImportWarning[]
): void {
  const tryAddRelationship = (
    rel: RelationshipJSONL,
    sourceEntityId: string
  ): void => {
    try {
      addRelationship(db, {
        from_id: rel.from,
        from_type: rel.from_type,
        to_id: rel.to,
        to_type: rel.to_type,
        relationship_type: rel.type,
      });
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        warnings.push({
          type: "missing_entity",
          message: `Skipping relationship: ${error.message}`,
          entityId: sourceEntityId,
          relationshipFrom: rel.from,
          relationshipTo: rel.to,
        });
        return;
      }
      throw error;
    }
  };
  for (const id of caseChanges.added) {
    const entity = entities.find((candidate) => candidate.id === id);
    for (const relationship of entity?.relationships ?? []) {
      tryAddRelationship(relationship, id);
    }
  }
  for (const id of caseChanges.updated) {
    const entity = entities.find((candidate) => candidate.id === id);
    if (!entity) continue;
    removeOutgoingRelationships(db, id, entityType);
    for (const relationship of entity.relationships) {
      tryAddRelationship(relationship, id);
    }
  }
}

/**
 * Import specs, issues, and ADRs from JSONL files
 */
export async function importFromJSONL(
  db: Database.Database,
  options: ImportOptions = {}
): Promise<ImportResult> {
  const {
    inputDir = ".sudocode",
    specsFile,
    issuesFile,
    adrsFile,
    dryRun = false,
    resolveCollisions: shouldResolve = true,
    forceUpdateIds = [],
  } = options;

  const config = getConfig(inputDir);
  if (isMarkdownFirst(config)) {
    console.warn(
      "[import] Warning: Markdown is configured as source of truth (sourceOfTruth = 'markdown')."
    );
    console.warn(
      "[import] JSONL import may override changes. Consider using 'sudocode sync --from-markdown' instead."
    );
  }

  const snapshot = readPersistedSnapshot(inputDir, {
    spec: specsFile,
    issue: issuesFile,
    adr: adrsFile,
  });
  const existing = existingEntitySnapshot(db);
  const specCollisions: CollisionInfo[] = detectCollisions(existing.spec, snapshot.spec).map(
    (collision) => ({ ...collision, type: "spec" })
  );
  const issueCollisions: CollisionInfo[] = detectCollisions(existing.issue, snapshot.issue).map(
    (collision) => ({ ...collision, type: "issue" })
  );
  const adrCollisions: CollisionInfo[] = detectCollisions(existing.adr, snapshot.adr).map(
    (collision) => ({ ...collision, type: "adr" })
  );
  const detectedCollisions = [
    ...specCollisions,
    ...issueCollisions,
    ...adrCollisions,
  ];
  let resolvedCollisions: CollisionInfo[] = detectedCollisions;

  if (shouldResolve) {
    const specResolution = resolveIdentityCollisions(snapshot.spec, existing.spec);
    const issueResolution = resolveIdentityCollisions(snapshot.issue, existing.issue);
    const adrResolution = resolveIdentityCollisions(snapshot.adr, existing.adr);
    snapshot.spec = specResolution.entities;
    snapshot.issue = issueResolution.entities;
    snapshot.adr = adrResolution.entities;
    const renames = [
      ...specResolution.renames,
      ...issueResolution.renames,
      ...adrResolution.renames,
    ];
    const collisions = [
      ...specResolution.collisions,
      ...issueResolution.collisions,
      ...adrResolution.collisions,
    ];
    applySnapshotRenames(snapshot, renames);
    resolvedCollisions = collisions.map(toCollisionInfo);
  }

  const changes: ChangeMap = {
    spec: detectChanges(existing.spec, snapshot.spec, forceUpdateIds),
    issue: detectChanges(existing.issue, snapshot.issue, forceUpdateIds),
    adr: detectChanges(existing.adr, snapshot.adr, forceUpdateIds),
  };
  const counts: CountMap = {
    spec: { added: 0, updated: 0, deleted: 0 },
    issue: { added: 0, updated: 0, deleted: 0 },
    adr: { added: 0, updated: 0, deleted: 0 },
  };
  const markdownFilesToDelete = dryRun ? [] : collectMarkdownDeletions(db, inputDir, changes);
  const warnings: ImportWarning[] = [];

  if (dryRun) {
    counts.spec = IMPORT_CASES.spec.import(db, snapshot.spec, changes.spec, true);
    counts.issue = IMPORT_CASES.issue.import(db, snapshot.issue, changes.issue, true);
    counts.adr = IMPORT_CASES.adr.import(db, snapshot.adr, changes.adr, true);
  } else {
    transaction(db, () => {
      counts.spec = IMPORT_CASES.spec.import(db, snapshot.spec, changes.spec, false);
      counts.issue = IMPORT_CASES.issue.import(db, snapshot.issue, changes.issue, false);
      counts.adr = IMPORT_CASES.adr.import(db, snapshot.adr, changes.adr, false);
      importSnapshotFeedback(db, snapshot);
      importCaseRelationships(db, "spec", snapshot.spec, changes.spec, warnings);
      importCaseRelationships(db, "issue", snapshot.issue, changes.issue, warnings);
      importCaseRelationships(db, "adr", snapshot.adr, changes.adr, warnings);
    });

    for (const filePath of markdownFilesToDelete) {
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (error) {
          console.warn(`Failed to delete markdown file: ${filePath}`, error);
        }
      }
    }
  }

  if (warnings.length > 0) {
    console.warn(
      `[Import] ${warnings.length} relationship(s) skipped due to missing entities:`
    );
    for (const warning of warnings) {
      console.warn(`  - ${warning.message}`);
    }
  }

  return {
    specs: counts.spec,
    issues: counts.issue,
    adrs: counts.adr,
    collisions: resolvedCollisions,
    warnings,
  };
}

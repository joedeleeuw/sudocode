/**
 * Import JSONL data to SQLite with collision resolution
 */

import type Database from "better-sqlite3";
import type { AdrJSONL, EntityType, SpecJSONL, IssueJSONL } from "@sudocode-ai/types";
import {
  ENTITY_ROWS,
  ENTITY_TYPE_VALUES,
  getEntityRow,
  type Entity,
  type EntitySnapshot,
  type EntitySnapshots,
} from "@sudocode-ai/types/entities";
import { normalizeMirrorPath, readPersistedSnapshot } from "./snapshot.js";
import {
  assignIdentities,
  createReferenceNamespace,
  remapEntityReferences,
  type AssignedIdentity,
  type IdentityClaim,
  type IdentityCollision,
  type ReferenceNamespace,
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
import { setTags } from "./operations/tags.js";
import {
  createFeedback,
  deleteFeedback,
  listFeedback,
} from "./operations/feedback.js";
import {
  applyProposedGraph,
  validateProposedSnapshot,
} from "./proposed-graph.js";
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
  collisions: IdentityCollision[];
  warnings?: ImportWarning[];
}

export interface ChangeDetection {
  added: string[];
  updated: string[];
  deleted: string[];
  unchanged: string[];
}

interface ChangeComparable {
  id: string;
  uuid: string;
  updated_at: string;
  title?: string;
  file_path?: string;
  content?: string;
  status?: string;
  priority?: number;
  assignee?: string;
  archived?: boolean;
  archived_at?: string;
  closed_at?: string;
  parent_id?: string;
  parent_uuid?: string;
  external_links?: unknown;
}

/**
 * Detect changes between existing and incoming entities
 * Uses UUID as the source of truth for entity identity
 */
export function detectChanges<
  Existing extends ChangeComparable,
  Incoming extends ChangeComparable,
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

function normalizeComparableField(
  field: keyof ChangeComparable,
  value: unknown
): unknown {
  if (field === "archived") {
    return Boolean(value ?? false);
  }
  if (field === "external_links") {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value) && value.length === 0) return undefined;
    return value;
  }
  return value ?? undefined;
}

/**
 * Check if an entity has changed
 */
function hasChanged(existing: ChangeComparable, incoming: ChangeComparable): boolean {
  const fields = [
    "id",
    "updated_at",
    "title",
    "file_path",
    "content",
    "status",
    "priority",
    "assignee",
    "archived",
    "archived_at",
    "closed_at",
    "parent_id",
    "parent_uuid",
    "external_links",
  ] as const;
  return fields.some((field) => {
    const incomingValue = incoming[field];
    if (incomingValue === undefined) return false;
    return (
      JSON.stringify(normalizeComparableField(field, existing[field])) !==
      JSON.stringify(normalizeComparableField(field, incomingValue))
    );
  });
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

  // Delete removed specs first
  for (const id of changes.deleted) {
    deleteSpec(db, id);
    deleted++;
  }

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
  for (const id of changes.deleted) {
    deleteAdr(db, id);
    deleted++;
  }
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

  // Delete removed issues first
  for (const id of changes.deleted) {
    deleteIssue(db, id);
    deleted++;
  }

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

function cachedFilePath(entity: Entity): string | undefined {
  if (!("file_path" in entity)) return undefined;
  return normalizeMirrorPath(entity.file_path);
}

function remapSnapshot(
  snapshot: EntitySnapshots,
  namespace: ReferenceNamespace,
  identities: ReadonlyMap<string, AssignedIdentity>
): EntitySnapshots {
  return {
    spec: snapshot.spec.map((entity) => remapEntityReferences("spec", entity, namespace, identities)),
    issue: snapshot.issue.map((entity) => remapEntityReferences("issue", entity, namespace, identities)),
    adr: snapshot.adr.map((entity) => remapEntityReferences("adr", entity, namespace, identities)),
  };
}

function proposeSnapshot(
  existing: ExistingEntities,
  snapshot: EntitySnapshots
): { proposed: EntitySnapshots; collisions: IdentityCollision[] } {
  const cached = new Map<string, Entity>();
  for (const row of ENTITY_ROWS) {
    for (const entity of existing[row.type]) cached.set(entity.uuid, entity);
  }
  const incoming = ENTITY_ROWS.flatMap((row) =>
    snapshot[row.type].map((entity) => ({ entityType: row.type, entity }))
  );
  const incomingUuids = new Set(incoming.map(({ entity }) => entity.uuid));
  const claims = incoming.map(({ entityType, entity }): IdentityClaim => {
    const local = cached.get(entity.uuid);
    const filePath = "file_path" in entity ? entity.file_path : undefined;
    return local
      ? {
          entityType,
          uuid: entity.uuid,
          id: local.id,
          filePath: cachedFilePath(local),
          createdAt: entity.created_at,
          fixed: true,
        }
      : {
          entityType,
          uuid: entity.uuid,
          id: entity.id,
          filePath,
          createdAt: entity.created_at,
          fixed: false,
        };
  });
  const retired = Array.from(cached.values()).filter(
    (entity) => !incomingUuids.has(entity.uuid)
  );
  const assignment = assignIdentities(claims, {
    ids: retired.map((entity) => entity.id),
    filePaths: retired.flatMap((entity) => cachedFilePath(entity) ?? []),
  });
  const namespace = createReferenceNamespace(
    ENTITY_TYPE_VALUES,
    true,
    incoming.map(({ entityType, entity }) => ({
      entityType,
      id: entity.id,
      uuid: entity.uuid,
    }))
  );
  return {
    proposed: remapSnapshot(snapshot, namespace, assignment.identities),
    collisions: assignment.collisions,
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

function proposedFeedbackChanged(
  existing: ReturnType<typeof listFeedback>[number],
  proposed: Parameters<typeof createFeedback>[1]
): boolean {
  const existingAnchor = existing.anchor
    ? JSON.parse(existing.anchor)
    : undefined;
  return (
    existing.from_id !== proposed.from_id ||
    existing.to_id !== proposed.to_id ||
    existing.feedback_type !== proposed.feedback_type ||
    existing.content !== proposed.content ||
    existing.agent !== (proposed.agent ?? "user") ||
    JSON.stringify(existingAnchor) !== JSON.stringify(proposed.anchor) ||
    (existing.dismissed ?? false) !== (proposed.dismissed ?? false) ||
    existing.created_at !== proposed.created_at ||
    existing.updated_at !== proposed.updated_at
  );
}

function importSnapshotFeedback(db: Database.Database, snapshot: EntitySnapshots): void {
  const proposed = ENTITY_ROWS.flatMap((row) =>
    snapshot[row.type].flatMap((entity) => entity.feedback ?? [])
  );
  const existing = listFeedback(db);
  const existingById = new Map(existing.map((feedback) => [feedback.id, feedback]));
  const proposedIds = new Set(proposed.map((feedback) => feedback.id));
  for (const feedback of existing) {
    if (!proposedIds.has(feedback.id)) deleteFeedback(db, feedback.id);
  }
  for (const feedback of proposed) {
    const current = existingById.get(feedback.id);
    if (!current) {
      createFeedback(db, feedback);
    } else if (proposedFeedbackChanged(current, feedback)) {
      deleteFeedback(db, feedback.id);
      createFeedback(db, feedback);
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
  const { proposed, collisions } = proposeSnapshot(existing, snapshot);
  const graph = validateProposedSnapshot(proposed);

  const changes: ChangeMap = {
    spec: detectChanges(existing.spec, proposed.spec, forceUpdateIds),
    issue: detectChanges(existing.issue, proposed.issue, forceUpdateIds),
    adr: detectChanges(existing.adr, proposed.adr, forceUpdateIds),
  };
  const counts: CountMap = {
    spec: { added: 0, updated: 0, deleted: 0 },
    issue: { added: 0, updated: 0, deleted: 0 },
    adr: { added: 0, updated: 0, deleted: 0 },
  };
  const markdownFilesToDelete = dryRun ? [] : collectMarkdownDeletions(db, inputDir, changes);
  const warnings: ImportWarning[] = [];

  if (dryRun) {
    counts.spec = IMPORT_CASES.spec.import(db, proposed.spec, changes.spec, true);
    counts.issue = IMPORT_CASES.issue.import(db, proposed.issue, changes.issue, true);
    counts.adr = IMPORT_CASES.adr.import(db, proposed.adr, changes.adr, true);
  } else {
    transaction(db, () => {
      counts.spec = IMPORT_CASES.spec.import(db, proposed.spec, changes.spec, false);
      counts.issue = IMPORT_CASES.issue.import(db, proposed.issue, changes.issue, false);
      counts.adr = IMPORT_CASES.adr.import(db, proposed.adr, changes.adr, false);
      importSnapshotFeedback(db, proposed);
      applyProposedGraph(db, graph);
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
    collisions,
    warnings,
  };
}

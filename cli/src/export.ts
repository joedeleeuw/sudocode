/**
 * Export SQLite data to JSONL files
 */

import type Database from "better-sqlite3";
import type {
  Spec,
  Adr,
  Issue,
  SpecJSONL,
  AdrJSONL,
  IssueJSONL,
  EntityType,
  RelationshipJSONL,
  FeedbackJSONL,
  ExternalLink,
} from "./types.js";
import { getEntityRow, type EntitySnapshot } from "@sudocode-ai/types/entities";
import { listSpecs } from "./operations/specs.js";
import { listAdrs } from "./operations/adrs.js";
import { listIssues } from "./operations/issues.js";
import { getOutgoingRelationships } from "./operations/relationships.js";
import { getTags } from "./operations/tags.js";
import {
  feedbackToJSONL,
  listSnapshotFeedback,
} from "./operations/feedback.js";
import { writeJSONL } from "./jsonl.js";
import { decodeSnapshotContent } from "./snapshot.js";
import {
  digestJSONLContent,
  isJSONLSynced,
  readJSONLFileDigest,
  recordJSONLSync,
  type JSONLFileDigest,
} from "./jsonl-sync-state.js";
import * as fs from "fs";

export interface ExportOptions {
  /**
   * Output directory for JSONL files
   */
  outputDir?: string;
  /**
   * Only export entities that have been updated since this timestamp
   */
  since?: Date;
  /**
   * Custom file names
   */
  specsFile?: string;
  issuesFile?: string;
  adrsFile?: string;
}

/**
 * Sort relationships for deterministic JSONL output
 * Sorts by: to_id, then to_type, then relationship type
 */
function sortRelationships(rels: RelationshipJSONL[]): RelationshipJSONL[] {
  return [...rels].sort((a, b) => {
    if (a.to !== b.to) return a.to.localeCompare(b.to);
    if (a.to_type !== b.to_type) return a.to_type.localeCompare(b.to_type);
    return a.type.localeCompare(b.type);
  });
}

/**
 * Sort tags alphabetically for deterministic JSONL output
 */
function sortTags(tags: string[]): string[] {
  return [...tags].sort((a, b) => a.localeCompare(b));
}

/**
 * Sort feedback for deterministic JSONL output
 * Sorts by: id (stable identifier)
 */
function sortFeedback(feedback: FeedbackJSONL[]): FeedbackJSONL[] {
  return [...feedback].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Sort external links for deterministic JSONL output
 * Sorts by: provider, then external_id
 */
function sortExternalLinks(links: ExternalLink[] | undefined): ExternalLink[] | undefined {
  if (!links || links.length === 0) return links;
  return [...links].sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.external_id.localeCompare(b.external_id);
  });
}

interface EntityJSONLMetadata {
  relationships: RelationshipJSONL[];
  tags: string[];
  external_links?: ExternalLink[];
  feedback?: FeedbackJSONL[];
}

function entityJSONLMetadata(
  db: Database.Database,
  entity: Spec | Issue | Adr,
  entityType: EntityType,
  existingExternalLinks?: Map<string, ExternalLink[]>
): EntityJSONLMetadata {
  const relationships = getOutgoingRelationships(db, entity.id, entityType);
  const relationshipsJSONL: RelationshipJSONL[] = relationships.map((rel) => ({
    from: rel.from_id,
    from_type: rel.from_type,
    to: rel.to_id,
    to_type: rel.to_type,
    type: rel.relationship_type,
  }));
  const externalLinks =
    entity.external_links ?? existingExternalLinks?.get(entity.id);
  const feedback = listSnapshotFeedback(db, entity.id, entityType).map(feedbackToJSONL);
  return {
    relationships: sortRelationships(relationshipsJSONL),
    tags: sortTags(getTags(db, entity.id, entityType)),
    external_links: sortExternalLinks(externalLinks),
    feedback: feedback.length > 0 ? sortFeedback(feedback) : undefined,
  };
}

export function specToJSONL(
  db: Database.Database,
  spec: Spec,
  existingExternalLinks?: Map<string, ExternalLink[]>
): SpecJSONL {
  return {
    ...spec,
    ...entityJSONLMetadata(db, spec, "spec", existingExternalLinks),
  };
}

export function adrToJSONL(
  db: Database.Database,
  adr: Adr & { superseded?: boolean },
  existingExternalLinks?: Map<string, ExternalLink[]>
): AdrJSONL {
  const { superseded: _superseded, ...persistedAdr } = adr;
  return {
    ...persistedAdr,
    ...entityJSONLMetadata(db, persistedAdr, "adr", existingExternalLinks),
  };
}

export function issueToJSONL(
  db: Database.Database,
  issue: Issue,
  existingExternalLinks?: Map<string, ExternalLink[]>
): IssueJSONL {
  return {
    ...issue,
    ...entityJSONLMetadata(db, issue, "issue", existingExternalLinks),
  };
}

/**
 * Export all specs to JSONL format
 * @param existingExternalLinks - Optional map of spec ID to external links (for preserving from existing JSONL)
 */
export function exportSpecsToJSONL(
  db: Database.Database,
  options: ExportOptions = {},
  existingExternalLinks?: Map<string, ExternalLink[]>
): SpecJSONL[] {
  const { since } = options;

  // Get all specs (including archived)
  const specs = listSpecs(db);

  // Filter by timestamp if requested
  const filtered = since
    ? specs.filter((spec) => new Date(spec.updated_at) > since)
    : specs;

  // Convert to JSONL format with relationships, tags, and external_links
  return filtered.map((spec) => specToJSONL(db, spec, existingExternalLinks));
}

export function exportAdrsToJSONL(
  db: Database.Database,
  options: ExportOptions = {},
  existingExternalLinks?: Map<string, ExternalLink[]>
): AdrJSONL[] {
  const adrs = listAdrs(db);
  const filtered = options.since
    ? adrs.filter((adr) => new Date(adr.updated_at) > options.since!)
    : adrs;
  return filtered.map((adr) => adrToJSONL(db, adr, existingExternalLinks));
}

/**
 * Export all issues to JSONL format
 * @param existingExternalLinks - Optional map of issue ID to external links (for preserving from existing JSONL)
 */
export function exportIssuesToJSONL(
  db: Database.Database,
  options: ExportOptions = {},
  existingExternalLinks?: Map<string, ExternalLink[]>
): IssueJSONL[] {
  const { since } = options;

  // Get all issues (including archived)
  const issues = listIssues(db);

  // Filter by timestamp if requested
  const filtered = since
    ? issues.filter((issue) => new Date(issue.updated_at) > since)
    : issues;

  // Convert to JSONL format with relationships, tags, and external_links
  return filtered.map((issue) => issueToJSONL(db, issue, existingExternalLinks));
}

interface ExistingSnapshotFile<K extends EntityType> {
  entities: EntitySnapshot<K>[];
  digest: JSONLFileDigest;
}

/**
 * The tracked JSONL file an export is about to replace, decoded by the one
 * snapshot decoder. A missing file holds nothing.
 */
function readExistingSnapshotFile<K extends EntityType>(
  filePath: string,
  entityType: K
): ExistingSnapshotFile<K> {
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  return {
    entities: content === null ? [] : decodeSnapshotContent(filePath, entityType, content),
    digest: digestJSONLContent(filePath, content),
  };
}

/**
 * Map entity ID to external_links from JSONL entities
 * (to preserve them since SQLite doesn't store them)
 */
function externalLinksById(
  entities: ReadonlyArray<{ id: string; external_links?: ExternalLink[] }>
): Map<string, ExternalLink[]> {
  const map = new Map<string, ExternalLink[]>();
  for (const entity of entities) {
    if (entity.external_links && entity.external_links.length > 0) {
      map.set(entity.id, entity.external_links);
    }
  }
  return map;
}

/**
 * IDs of JSONL entities the database has never imported. None when the
 * database last imported or exported this exact file content: anything
 * missing from the database then was deleted on purpose.
 */
function unimportedIds(
  db: Database.Database,
  existing: ExistingSnapshotFile<EntityType>,
  dbEntities: ReadonlyArray<{ uuid: string }>
): string[] {
  if (isJSONLSynced(db, existing.digest)) {
    return [];
  }
  const known = new Set(dbEntities.map((entity) => entity.uuid));
  return existing.entities
    .filter((entity) => !known.has(entity.uuid))
    .map((entity) => entity.id);
}

/**
 * Thrown instead of exporting when the export would delete JSONL entities the
 * database never imported (fresh clone/worktree, or JSONL changed by git).
 */
export class UnimportedJSONLEntitiesError extends Error {
  constructor(readonly unimported: Array<{ filePath: string; ids: string[] }>) {
    super(
      "Refusing to export: " +
        unimported
          .map(
            ({ filePath, ids }) =>
              `${filePath} has ${ids.length} entities the database never imported (${ids.join(", ")})`
          )
          .join("; ") +
        ". Exporting would delete them from the JSONL. Run `sudocode import` (or restart the server) " +
        "to load the JSONL first; import makes the database match the JSONL."
    );
    this.name = "UnimportedJSONLEntitiesError";
  }
}

/**
 * Export specs, issues, and ADRs to JSONL files
 * Preserves external_links from existing JSONL files
 */
export async function exportToJSONL(
  db: Database.Database,
  options: ExportOptions = {}
): Promise<{ specsCount: number; issuesCount: number; adrsCount: number }> {
  const {
    outputDir = ".sudocode",
    specsFile = getEntityRow("spec").jsonlFile,
    issuesFile = getEntityRow("issue").jsonlFile,
    adrsFile = getEntityRow("adr").jsonlFile,
  } = options;

  const specsPath = `${outputDir}/${specsFile}`;
  const issuesPath = `${outputDir}/${issuesFile}`;
  const adrsPath = `${outputDir}/${adrsFile}`;

  const existingSpecs = readExistingSnapshotFile(specsPath, "spec");
  const existingIssues = readExistingSnapshotFile(issuesPath, "issue");
  const existingAdrs = readExistingSnapshotFile(adrsPath, "adr");

  const unimported = [
    { filePath: specsPath, ids: unimportedIds(db, existingSpecs, listSpecs(db)) },
    { filePath: issuesPath, ids: unimportedIds(db, existingIssues, listIssues(db)) },
    { filePath: adrsPath, ids: unimportedIds(db, existingAdrs, listAdrs(db)) },
  ].filter(({ ids }) => ids.length > 0);
  if (unimported.length > 0) {
    throw new UnimportedJSONLEntitiesError(unimported);
  }

  const specs = exportSpecsToJSONL(db, options, externalLinksById(existingSpecs.entities));
  await writeJSONL(specsPath, specs);
  recordJSONLSync(db, readJSONLFileDigest(specsPath));
  const issues = exportIssuesToJSONL(db, options, externalLinksById(existingIssues.entities));
  await writeJSONL(issuesPath, issues);
  recordJSONLSync(db, readJSONLFileDigest(issuesPath));
  const adrs = exportAdrsToJSONL(db, options, externalLinksById(existingAdrs.entities));
  await writeJSONL(adrsPath, adrs);
  recordJSONLSync(db, readJSONLFileDigest(adrsPath));

  return {
    specsCount: specs.length,
    issuesCount: issues.length,
    adrsCount: adrs.length,
  };
}

/**
 * Debouncer for export operations
 */
export class ExportDebouncer {
  private timeoutId: NodeJS.Timeout | null = null;
  private pending: boolean = false;

  constructor(
    private db: Database.Database,
    private delayMs: number = 5000,
    private options: ExportOptions = {}
  ) {}

  /**
   * Trigger an export (will be debounced)
   */
  trigger(): void {
    this.pending = true;

    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }

    this.timeoutId = setTimeout(() => {
      this.execute();
    }, this.delayMs);
  }

  /**
   * Execute the export immediately
   */
  async execute(): Promise<void> {
    if (!this.pending) {
      return;
    }

    this.pending = false;
    this.timeoutId = null;

    try {
      await exportToJSONL(this.db, this.options);
    } catch (error) {
      console.error("Export failed:", error);
      throw error;
    }
  }

  /**
   * Cancel any pending export
   */
  cancel(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.pending = false;
  }

  /**
   * Check if an export is pending
   */
  isPending(): boolean {
    return this.pending;
  }

  /**
   * Wait for any pending export to complete
   */
  async flush(): Promise<void> {
    if (this.pending) {
      if (this.timeoutId) {
        clearTimeout(this.timeoutId);
        this.timeoutId = null;
      }
      await this.execute();
    }
  }
}

/**
 * Create a debounced export function
 */
export function createDebouncedExport(
  db: Database.Database,
  delayMs: number = 5000,
  options: ExportOptions = {}
): ExportDebouncer {
  return new ExportDebouncer(db, delayMs, options);
}

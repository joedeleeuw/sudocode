/**
 * Export SQLite data to JSONL files
 */

import type Database from "better-sqlite3";
import type {
  Spec,
  Issue,
  SpecJSONL,
  IssueJSONL,
  RelationshipJSONL,
  FeedbackJSONL,
  ExternalLink,
} from "./types.js";
import { listSpecs } from "./operations/specs.js";
import { listIssues } from "./operations/issues.js";
import { getOutgoingRelationships } from "./operations/relationships.js";
import { getTags } from "./operations/tags.js";
import { listFeedback } from "./operations/feedback.js";
import { publishJSONL, recoverPublication } from "./tracker-publication.js";
import * as path from "path";
import {
  readJSONLSnapshot,
  isJSONLSynced,
  type JSONLSnapshot,
} from "./jsonl-sync-state.js";

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
function sortExternalLinks(
  links: ExternalLink[] | undefined,
): ExternalLink[] | undefined {
  if (!links || links.length === 0) return links;
  return [...links].sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.external_id.localeCompare(b.external_id);
  });
}

export function groupFeedback(db: Database.Database) {
  const feedbackByOwner = new Map<string, FeedbackJSONL[]>();
  for (const feedback of listFeedback(db)) {
    const owner = feedback.from_id || feedback.to_id;
    const owned = feedbackByOwner.get(owner) ?? [];
    owned.push({
      id: feedback.id,
      from_id: feedback.from_id || undefined,
      to_id: feedback.to_id,
      feedback_type: feedback.feedback_type,
      content: feedback.content,
      agent: feedback.agent,
      anchor:
        typeof feedback.anchor === "string"
          ? JSON.parse(feedback.anchor)
          : feedback.anchor,
      dismissed: feedback.dismissed,
      created_at: feedback.created_at,
      updated_at: feedback.updated_at,
    });
    feedbackByOwner.set(owner, owned);
  }
  return feedbackByOwner;
}

/**
 * Convert a Spec to SpecJSONL format with embedded relationships and tags
 * @param existingExternalLinks - Optional map of spec ID to external links (preserved from existing JSONL)
 */
export function specToJSONL(
  db: Database.Database,
  spec: Spec,
  existingExternalLinks?: Map<string, ExternalLink[]>,
  feedbackByOwner = groupFeedback(db),
): SpecJSONL {
  const relationships = getOutgoingRelationships(db, spec.id, "spec");

  const relationshipsJSONL: RelationshipJSONL[] = relationships.map((rel) => ({
    from: rel.from_id,
    from_type: rel.from_type,
    to: rel.to_id,
    to_type: rel.to_type,
    type: rel.relationship_type,
  }));

  const tags = getTags(db, spec.id, "spec");

  const externalLinks =
    spec.external_links ?? existingExternalLinks?.get(spec.id);

  const feedback = sortFeedback(feedbackByOwner.get(spec.id) ?? []);
  return {
    ...spec,
    feedback: feedback.length > 0 ? feedback : undefined,
    relationships: sortRelationships(relationshipsJSONL),
    tags: sortTags(tags),
    external_links: sortExternalLinks(externalLinks),
  };
}

/**
 * Convert an Issue to IssueJSONL format with embedded relationships and tags
 * @param existingExternalLinks - Optional map of issue ID to external links (preserved from existing JSONL)
 */
export function issueToJSONL(
  db: Database.Database,
  issue: Issue,
  existingExternalLinks?: Map<string, ExternalLink[]>,
  feedbackByOwner = groupFeedback(db),
): IssueJSONL {
  const relationships = getOutgoingRelationships(db, issue.id, "issue");

  const relationshipsJSONL: RelationshipJSONL[] = relationships.map((rel) => ({
    from: rel.from_id,
    from_type: rel.from_type,
    to: rel.to_id,
    to_type: rel.to_type,
    type: rel.relationship_type,
  }));

  const tags = getTags(db, issue.id, "issue");

  const feedbackJSONL = feedbackByOwner.get(issue.id) ?? [];

  const externalLinks =
    issue.external_links ?? existingExternalLinks?.get(issue.id);

  const sortedFeedback = sortFeedback(feedbackJSONL);

  return {
    ...issue,
    relationships: sortRelationships(relationshipsJSONL),
    tags: sortTags(tags),
    feedback: sortedFeedback.length > 0 ? sortedFeedback : undefined,
    external_links: sortExternalLinks(externalLinks),
  };
}

/**
 * Export all specs to JSONL format
 * @param existingExternalLinks - Optional map of spec ID to external links (for preserving from existing JSONL)
 */
export function exportSpecsToJSONL(
  db: Database.Database,
  options: ExportOptions = {},
  existingExternalLinks?: Map<string, ExternalLink[]>,
  feedbackByOwner = groupFeedback(db),
): SpecJSONL[] {
  const { since } = options;

  const specs = listSpecs(db);

  const filtered = since
    ? specs.filter((spec) => new Date(spec.updated_at) > since)
    : specs;

  return filtered.map((spec) =>
    specToJSONL(db, spec, existingExternalLinks, feedbackByOwner),
  );
}

/**
 * Export all issues to JSONL format
 * @param existingExternalLinks - Optional map of issue ID to external links (for preserving from existing JSONL)
 */
export function exportIssuesToJSONL(
  db: Database.Database,
  options: ExportOptions = {},
  existingExternalLinks?: Map<string, ExternalLink[]>,
  feedbackByOwner = groupFeedback(db),
): IssueJSONL[] {
  const { since } = options;

  const issues = listIssues(db);

  const filtered = since
    ? issues.filter((issue) => new Date(issue.updated_at) > since)
    : issues;

  return filtered.map((issue) =>
    issueToJSONL(db, issue, existingExternalLinks, feedbackByOwner),
  );
}

/**
 * Map entity ID to external_links from JSONL entities
 * (to preserve them since SQLite doesn't store them)
 */
function externalLinksById(
  entities: Array<{ id: string; external_links?: ExternalLink[] }>,
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
  snapshot: JSONLSnapshot<{ id: string; uuid: string }>,
  dbEntities: Array<{ uuid: string }>,
): string[] {
  if (isJSONLSynced(db, snapshot)) {
    return [];
  }
  const known = new Set(dbEntities.map((entity) => entity.uuid));
  return snapshot.entities
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
              `${filePath} has ${ids.length} entities the database never imported (${ids.join(", ")})`,
          )
          .join("; ") +
        ". Exporting would delete them from the JSONL. Run `sudocode import` (or restart the server) " +
        "to load the JSONL first; import makes the database match the JSONL.",
    );
    this.name = "UnimportedJSONLEntitiesError";
  }
}

/**
 * Export both specs and issues to JSONL files
 * Preserves external_links from existing JSONL files
 */
function serializeEntities(entities: (SpecJSONL | IssueJSONL)[]) {
  return (
    [...entities]
      .sort(
        (left, right) =>
          left.created_at.localeCompare(right.created_at) ||
          left.id.localeCompare(right.id),
      )
      .map((entity) => JSON.stringify(entity))
      .join("\n") + "\n"
  );
}

export function exportToJSONL(
  db: Database.Database,
  options: ExportOptions = {},
): { specsCount: number; issuesCount: number } {
  if (!db.inTransaction) {
    db.pragma("synchronous = FULL");
    db.exec("BEGIN IMMEDIATE");
    try {
      const counts = exportToJSONL(db, options);
      db.exec("COMMIT");
      recoverPublication(db, options.outputDir ?? ".sudocode");
      return counts;
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      recoverPublication(db, options.outputDir ?? ".sudocode");
      throw error;
    }
  }
  recoverPublication(db, options.outputDir ?? ".sudocode");
  const {
    outputDir = ".sudocode",
    specsFile = "specs.jsonl",
    issuesFile = "issues.jsonl",
  } = options;

  const specsPath = `${outputDir}/${specsFile}`;
  const issuesPath = `${outputDir}/${issuesFile}`;

  const existingSpecs = readJSONLSnapshot<SpecJSONL>(specsPath);
  const existingIssues = readJSONLSnapshot<IssueJSONL>(issuesPath);

  const unimported = [
    {
      filePath: specsPath,
      ids: unimportedIds(db, existingSpecs, listSpecs(db)),
    },
    {
      filePath: issuesPath,
      ids: unimportedIds(db, existingIssues, listIssues(db)),
    },
  ].filter(({ ids }) => ids.length > 0);
  if (unimported.length > 0) {
    throw new UnimportedJSONLEntitiesError(unimported);
  }

  const feedbackByOwner = groupFeedback(db);
  const specs = exportSpecsToJSONL(
    db,
    options,
    externalLinksById(existingSpecs.entities),
    feedbackByOwner,
  );

  const issues = exportIssuesToJSONL(
    db,
    options,
    externalLinksById(existingIssues.entities),
    feedbackByOwner,
  );
  publishJSONL(db, [
    { filePath: path.resolve(specsPath), content: serializeEntities(specs) },
    { filePath: path.resolve(issuesPath), content: serializeEntities(issues) },
  ]);

  return {
    specsCount: specs.length,
    issuesCount: issues.length,
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
    private options: ExportOptions = {},
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
  options: ExportOptions = {},
): ExportDebouncer {
  return new ExportDebouncer(db, delayMs, options);
}

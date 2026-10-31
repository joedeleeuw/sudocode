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
import { getEntityRow } from "@sudocode-ai/types/entities";
import { listSpecs } from "./operations/specs.js";
import { listAdrs } from "./operations/adrs.js";
import { listIssues } from "./operations/issues.js";
import { getOutgoingRelationships } from "./operations/relationships.js";
import { getTags } from "./operations/tags.js";
import { listFeedback } from "./operations/feedback.js";
import { writeJSONL, readJSONLSync } from "./jsonl.js";

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
  return {
    relationships: sortRelationships(relationshipsJSONL),
    tags: sortTags(getTags(db, entity.id, entityType)),
    external_links: sortExternalLinks(externalLinks),
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
  adr: Adr,
  existingExternalLinks?: Map<string, ExternalLink[]>
): AdrJSONL {
  return {
    ...adr,
    ...entityJSONLMetadata(db, adr, "adr", existingExternalLinks),
  };
}

export function issueToJSONL(
  db: Database.Database,
  issue: Issue,
  existingExternalLinks?: Map<string, ExternalLink[]>
): IssueJSONL {
  const feedbackList = listFeedback(db, { from_id: issue.id });
  const feedbackJSONL: FeedbackJSONL[] = feedbackList.map((feedback) => ({
    id: feedback.id,
    from_id: feedback.from_id,
    to_id: feedback.to_id,
    feedback_type: feedback.feedback_type,
    content: feedback.content,
    agent: feedback.agent,
    anchor:
      feedback.anchor && typeof feedback.anchor === "string"
        ? JSON.parse(feedback.anchor)
        : feedback.anchor,
    dismissed: feedback.dismissed,
    created_at: feedback.created_at,
    updated_at: feedback.updated_at,
  }));
  const sortedFeedback = sortFeedback(feedbackJSONL);
  return {
    ...issue,
    ...entityJSONLMetadata(db, issue, "issue", existingExternalLinks),
    feedback: sortedFeedback.length > 0 ? sortedFeedback : undefined,
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

/**
 * Read existing external_links from a JSONL file
 * Returns a map of entity ID to external_links array
 */
function readExistingExternalLinks<T extends { id: string; external_links?: ExternalLink[] }>(
  filePath: string
): Map<string, ExternalLink[]> {
  const map = new Map<string, ExternalLink[]>();
  const entities = readJSONLSync<T>(filePath, { skipErrors: true });
  for (const entity of entities) {
    if (entity.external_links && entity.external_links.length > 0) {
      map.set(entity.id, entity.external_links);
    }
  }
  return map;
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

  const existingSpecLinks = readExistingExternalLinks<SpecJSONL>(specsPath);
  const existingIssueLinks = readExistingExternalLinks<IssueJSONL>(issuesPath);
  const existingAdrLinks = readExistingExternalLinks<AdrJSONL>(adrsPath);

  const specs = exportSpecsToJSONL(db, options, existingSpecLinks);
  await writeJSONL(specsPath, specs);
  const issues = exportIssuesToJSONL(db, options, existingIssueLinks);
  await writeJSONL(issuesPath, issues);
  const adrs = exportAdrsToJSONL(db, options, existingAdrLinks);
  await writeJSONL(adrsPath, adrs);

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

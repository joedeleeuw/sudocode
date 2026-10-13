/**
 * External link lookups for Specs and Issues, read from the tracked JSONL.
 */

import type {
  ExternalLink,
  SpecJSONL,
  IssueJSONL,
  IntegrationProviderName,
} from "../types.js";
import { readJSONLSync } from "../jsonl.js";
import * as path from "path";

/**
 * Get the path to the specs JSONL file
 */
function getSpecsJsonlPath(sudocodeDir: string): string {
  return path.join(sudocodeDir, "specs.jsonl");
}

/**
 * Get the path to the issues JSONL file
 */
function getIssuesJsonlPath(sudocodeDir: string): string {
  return path.join(sudocodeDir, "issues.jsonl");
}

// =============================================================================
// Spec External Link Operations
// =============================================================================

/**
 * Get a spec from JSONL by ID
 */
export function getSpecFromJsonl(
  sudocodeDir: string,
  specId: string
): SpecJSONL | null {
  const specsPath = getSpecsJsonlPath(sudocodeDir);
  const specs = readJSONLSync<SpecJSONL>(specsPath, { skipErrors: true });
  return specs.find((s) => s.id === specId) ?? null;
}

/**
 * Find specs by external link
 */
export function findSpecsByExternalLink(
  sudocodeDir: string,
  provider: IntegrationProviderName,
  externalId: string
): SpecJSONL[] {
  const specsPath = getSpecsJsonlPath(sudocodeDir);
  const specs = readJSONLSync<SpecJSONL>(specsPath, { skipErrors: true });
  return specs.filter((s) =>
    s.external_links?.some(
      (l) => l.provider === provider && l.external_id === externalId
    )
  );
}

/**
 * Get all external links for a spec
 */
export function getSpecExternalLinks(
  sudocodeDir: string,
  specId: string
): ExternalLink[] {
  const spec = getSpecFromJsonl(sudocodeDir, specId);
  if (!spec) {
    throw new Error(`Spec not found: ${specId}`);
  }
  return spec.external_links || [];
}

// =============================================================================
// Issue External Link Operations
// =============================================================================

/**
 * Get an issue from JSONL by ID
 */
export function getIssueFromJsonl(
  sudocodeDir: string,
  issueId: string
): IssueJSONL | null {
  const issuesPath = getIssuesJsonlPath(sudocodeDir);
  const issues = readJSONLSync<IssueJSONL>(issuesPath, { skipErrors: true });
  return issues.find((i) => i.id === issueId) ?? null;
}

/**
 * Find issues by external link
 */
export function findIssuesByExternalLink(
  sudocodeDir: string,
  provider: IntegrationProviderName,
  externalId: string
): IssueJSONL[] {
  const issuesPath = getIssuesJsonlPath(sudocodeDir);
  const issues = readJSONLSync<IssueJSONL>(issuesPath, { skipErrors: true });
  return issues.filter((i) =>
    i.external_links?.some(
      (l) => l.provider === provider && l.external_id === externalId
    )
  );
}

/**
 * Get all external links for an issue
 */
export function getIssueExternalLinks(
  sudocodeDir: string,
  issueId: string
): ExternalLink[] {
  const issue = getIssueFromJsonl(sudocodeDir, issueId);
  if (!issue) {
    throw new Error(`Issue not found: ${issueId}`);
  }
  return issue.external_links || [];
}

// =============================================================================
// Generic Operations
// =============================================================================

/**
 * Find all entities (specs and issues) by external link
 */
export function findEntitiesByExternalLink(
  sudocodeDir: string,
  provider: IntegrationProviderName,
  externalId: string
): { specs: SpecJSONL[]; issues: IssueJSONL[] } {
  return {
    specs: findSpecsByExternalLink(sudocodeDir, provider, externalId),
    issues: findIssuesByExternalLink(sudocodeDir, provider, externalId),
  };
}

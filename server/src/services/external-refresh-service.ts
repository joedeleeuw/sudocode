import { persistMutation } from "@sudocode-ai/cli/dist/tracker-mutation.js";
import { getSpec, updateSpec } from "@sudocode-ai/cli/dist/operations/specs.js";
import {
  getIssue,
  updateIssue,
} from "@sudocode-ai/cli/dist/operations/issues.js";
/**
 * Refresh Service - handles refreshing entities from external sources
 *
 * Provides change detection via content_hash comparison and refresh logic
 * for syncing entities with their external sources.
 */

import { createHash } from "crypto";
import type Database from "better-sqlite3";
import type {
  ExternalLink,
  IntegrationProvider,
  Spec,
  Issue,
} from "@sudocode-ai/types";
import {
  getSpecFromJsonl,
  getIssueFromJsonl,
} from "@sudocode-ai/cli/dist/operations/external-links.js";
import {
  loadPlugin,
  getFirstPartyPlugins,
} from "@sudocode-ai/cli/dist/integrations/index.js";
import { updateExistingSpec } from "./specs.js";
import { updateExistingIssue } from "./issues.js";
import { readJSONLSync } from "@sudocode-ai/cli/dist/jsonl.js";
import * as path from "path";

/**
 * Change between local and remote values for a field
 */
export interface FieldChange {
  field: string;
  localValue: string;
  remoteValue: string;
}

/**
 * Result of refreshing a single entity
 */
export interface RefreshResult {
  updated: boolean;
  hasLocalChanges: boolean;
  changes?: FieldChange[];
  entity?: Spec | Issue;
  stale?: boolean;
  error?: string;
}

/**
 * Status of a bulk refresh operation for a single entity
 */
export type BulkRefreshStatus = "updated" | "skipped" | "failed" | "stale";

/**
 * Result for a single entity in bulk refresh
 */
export interface BulkRefreshEntityResult {
  entityId: string;
  status: BulkRefreshStatus;
  error?: string;
}

/**
 * Result of bulk refresh operation
 */
export interface BulkRefreshResult {
  refreshed: number;
  skipped: number;
  failed: number;
  stale: number;
  results: BulkRefreshEntityResult[];
}

/**
 * Compute SHA256 hash of content for change detection
 * Matches the implementation in import.ts
 */
export function computeContentHash(title: string, content: string): string {
  const hash = createHash("sha256");
  hash.update(title);
  hash.update(content || "");
  return hash.digest("hex");
}

/**
 * Detect local changes by comparing current content hash with stored hash
 *
 * @param title - Current entity title
 * @param content - Current entity content
 * @param storedHash - Hash stored in external_link.content_hash
 * @returns true if local changes were detected
 */
export function detectLocalChanges(
  title: string,
  content: string,
  storedHash: string | undefined,
): boolean {
  if (!storedHash) {
    return false;
  }
  const currentHash = computeContentHash(title, content);
  return currentHash !== storedHash;
}

/**
 * Compute field-level changes between local entity and remote entity
 */
export function computeFieldChanges(
  localTitle: string,
  localContent: string,
  remoteTitle: string,
  remoteContent: string,
): FieldChange[] {
  const changes: FieldChange[] = [];

  if (localTitle !== remoteTitle) {
    changes.push({
      field: "title",
      localValue: localTitle,
      remoteValue: remoteTitle,
    });
  }

  if (localContent !== (remoteContent || "")) {
    changes.push({
      field: "content",
      localValue: localContent,
      remoteValue: remoteContent || "",
    });
  }

  return changes;
}

function updateExternalLink(
  database: Database.Database,
  entityType: "spec" | "issue",
  entityId: string,
  externalId: string,
  updates: Partial<ExternalLink>,
) {
  const operations = {
    spec: { get: getSpec, update: updateSpec },
    issue: { get: getIssue, update: updateIssue },
  };
  const entity = operations[entityType].get(database, entityId);
  if (!entity) throw new Error(`${entityType}.${entityId}: entity missing`);
  const links = entity.external_links;
  if (!links?.some((link) => link.external_id === externalId)) {
    throw new Error(
      `${entityId}.external_links.external_id: missing ${externalId}`,
    );
  }
  operations[entityType].update(database, entityId, {
    external_links: JSON.stringify(
      links.map((link) =>
        link.external_id === externalId ? { ...link, ...updates } : link,
      ),
    ),
  });
}

/**
 * Get a provider instance for the given provider name
 */
async function getProvider(
  providerName: string,
  projectPath: string,
): Promise<IntegrationProvider | null> {
  const firstPartyPlugins = getFirstPartyPlugins();

  for (const p of firstPartyPlugins) {
    if (p.name === providerName) {
      const plugin = await loadPlugin(p.name);
      if (plugin) {
        return plugin.createProvider({}, projectPath);
      }
    }
  }

  const plugin = await loadPlugin(providerName);
  if (plugin) {
    return plugin.createProvider({}, projectPath);
  }

  return null;
}

/**
 * Refresh a spec from its external source
 *
 * @param db - Database instance
 * @param sudocodeDir - Path to .sudocode directory
 * @param projectPath - Path to project root
 * @param specId - ID of spec to refresh
 * @param force - If true, skip conflict check and overwrite local changes
 * @returns Refresh result
 */
export async function refreshSpec(
  db: Database.Database,
  sudocodeDir: string,
  projectPath: string,
  specId: string,
  force: boolean = false,
): Promise<RefreshResult> {
  const spec = getSpecFromJsonl(sudocodeDir, specId);
  if (!spec) {
    return {
      updated: false,
      hasLocalChanges: false,
      error: `Spec not found: ${specId}`,
    };
  }

  const externalLinks = spec.external_links || [];
  if (externalLinks.length === 0) {
    return {
      updated: false,
      hasLocalChanges: false,
      error: "Spec has no external links",
    };
  }

  const link = externalLinks.find(
    (l) =>
      l.sync_enabled &&
      (l.sync_direction === "inbound" || l.sync_direction === "bidirectional"),
  );

  if (!link) {
    return {
      updated: false,
      hasLocalChanges: false,
      error: "No sync-enabled inbound external link found",
    };
  }

  const provider = await getProvider(link.provider, projectPath);
  if (!provider) {
    return {
      updated: false,
      hasLocalChanges: false,
      error: `Provider not found: ${link.provider}`,
    };
  }

  try {
    await provider.initialize();

    const remoteEntity = await provider.fetchEntity(link.external_id);

    return persistMutation(db, sudocodeDir, () => {
      if (!remoteEntity) {
        updateExternalLink(db, "spec", specId, link.external_id, {
          sync_enabled: false,
          metadata: {
            ...link.metadata,
            stale: true,
            stale_reason: "external_entity_not_found",
            stale_at: new Date().toISOString(),
          },
        });

        return {
          updated: false,
          hasLocalChanges: false,
          stale: true,
          error: "External entity no longer exists",
        };
      }

      const hasLocalChanges = detectLocalChanges(
        spec.title,
        spec.content || "",
        link.content_hash,
      );

      if (hasLocalChanges && !force) {
        const changes = computeFieldChanges(
          spec.title,
          spec.content || "",
          remoteEntity.title,
          remoteEntity.description || "",
        );

        return {
          updated: false,
          hasLocalChanges: true,
          changes,
        };
      }

      const newContentHash = computeContentHash(
        remoteEntity.title,
        remoteEntity.description || "",
      );
      const now = new Date().toISOString();

      const updatedSpec = updateExistingSpec(db, specId, {
        title: remoteEntity.title,
        content: remoteEntity.description || "",
      });

      updateExternalLink(db, "spec", specId, link.external_id, {
        content_hash: newContentHash,
        last_synced_at: now,
        external_updated_at: remoteEntity.updated_at,
      });

      return {
        updated: true,
        hasLocalChanges: false,
        entity: updatedSpec,
      };
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      updated: false,
      hasLocalChanges: false,
      error: `Refresh failed: ${errorMessage}`,
    };
  } finally {
    await provider.dispose();
  }
}

/**
 * Refresh an issue from its external source
 *
 * @param db - Database instance
 * @param sudocodeDir - Path to .sudocode directory
 * @param projectPath - Path to project root
 * @param issueId - ID of issue to refresh
 * @param force - If true, skip conflict check and overwrite local changes
 * @returns Refresh result
 */
export async function refreshIssue(
  db: Database.Database,
  sudocodeDir: string,
  projectPath: string,
  issueId: string,
  force: boolean = false,
): Promise<RefreshResult> {
  const issue = getIssueFromJsonl(sudocodeDir, issueId);
  if (!issue) {
    return {
      updated: false,
      hasLocalChanges: false,
      error: `Issue not found: ${issueId}`,
    };
  }

  const externalLinks = issue.external_links || [];
  if (externalLinks.length === 0) {
    return {
      updated: false,
      hasLocalChanges: false,
      error: "Issue has no external links",
    };
  }

  const link = externalLinks.find(
    (l) =>
      l.sync_enabled &&
      (l.sync_direction === "inbound" || l.sync_direction === "bidirectional"),
  );

  if (!link) {
    return {
      updated: false,
      hasLocalChanges: false,
      error: "No sync-enabled inbound external link found",
    };
  }

  const provider = await getProvider(link.provider, projectPath);
  if (!provider) {
    return {
      updated: false,
      hasLocalChanges: false,
      error: `Provider not found: ${link.provider}`,
    };
  }

  try {
    await provider.initialize();

    const remoteEntity = await provider.fetchEntity(link.external_id);

    return persistMutation(db, sudocodeDir, () => {
      if (!remoteEntity) {
        updateExternalLink(db, "issue", issueId, link.external_id, {
          sync_enabled: false,
          metadata: {
            ...link.metadata,
            stale: true,
            stale_reason: "external_entity_not_found",
            stale_at: new Date().toISOString(),
          },
        });

        return {
          updated: false,
          hasLocalChanges: false,
          stale: true,
          error: "External entity no longer exists",
        };
      }

      const hasLocalChanges = detectLocalChanges(
        issue.title,
        issue.content || "",
        link.content_hash,
      );

      if (hasLocalChanges && !force) {
        const changes = computeFieldChanges(
          issue.title,
          issue.content || "",
          remoteEntity.title,
          remoteEntity.description || "",
        );

        return {
          updated: false,
          hasLocalChanges: true,
          changes,
        };
      }

      const newContentHash = computeContentHash(
        remoteEntity.title,
        remoteEntity.description || "",
      );
      const now = new Date().toISOString();

      const updatedIssue = updateExistingIssue(db, issueId, {
        title: remoteEntity.title,
        content: remoteEntity.description || "",
      });

      updateExternalLink(db, "issue", issueId, link.external_id, {
        content_hash: newContentHash,
        last_synced_at: now,
        external_updated_at: remoteEntity.updated_at,
      });

      return {
        updated: true,
        hasLocalChanges: false,
        entity: updatedIssue,
      };
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      updated: false,
      hasLocalChanges: false,
      error: `Refresh failed: ${errorMessage}`,
    };
  } finally {
    await provider.dispose();
  }
}

/**
 * Refresh multiple entities from their external sources
 *
 * @param db - Database instance
 * @param sudocodeDir - Path to .sudocode directory
 * @param projectPath - Path to project root
 * @param options - Filter options for bulk refresh
 * @returns Bulk refresh result
 */
export async function bulkRefresh(
  db: Database.Database,
  sudocodeDir: string,
  projectPath: string,
  options: {
    provider?: string;
    entityIds?: string[];
    force?: boolean;
  } = {},
): Promise<BulkRefreshResult> {
  const { provider: providerFilter, entityIds, force = false } = options;

  const results: BulkRefreshEntityResult[] = [];
  let refreshed = 0;
  let skipped = 0;
  let failed = 0;
  let stale = 0;

  const entitiesToRefresh: Array<{
    id: string;
    type: "spec" | "issue";
  }> = [];

  const specsPath = path.join(sudocodeDir, "specs.jsonl");
  const issuesPath = path.join(sudocodeDir, "issues.jsonl");
  const specs = readJSONLSync<any>(specsPath, { skipErrors: true });
  const issues = readJSONLSync<any>(issuesPath, { skipErrors: true });

  for (const spec of specs) {
    if (entityIds && !entityIds.includes(spec.id)) continue;

    const links = spec.external_links || [];
    const hasMatchingLink = links.some(
      (l: ExternalLink) =>
        l.sync_enabled &&
        (l.sync_direction === "inbound" ||
          l.sync_direction === "bidirectional") &&
        (!providerFilter || l.provider === providerFilter),
    );

    if (hasMatchingLink) {
      entitiesToRefresh.push({ id: spec.id, type: "spec" });
    }
  }

  for (const issue of issues) {
    if (entityIds && !entityIds.includes(issue.id)) continue;

    const links = issue.external_links || [];
    const hasMatchingLink = links.some(
      (l: ExternalLink) =>
        l.sync_enabled &&
        (l.sync_direction === "inbound" ||
          l.sync_direction === "bidirectional") &&
        (!providerFilter || l.provider === providerFilter),
    );

    if (hasMatchingLink) {
      entitiesToRefresh.push({ id: issue.id, type: "issue" });
    }
  }

  for (const entity of entitiesToRefresh) {
    try {
      let result: RefreshResult;

      if (entity.type === "spec") {
        result = await refreshSpec(
          db,
          sudocodeDir,
          projectPath,
          entity.id,
          force,
        );
      } else {
        result = await refreshIssue(
          db,
          sudocodeDir,
          projectPath,
          entity.id,
          force,
        );
      }

      if (result.stale) {
        stale++;
        results.push({
          entityId: entity.id,
          status: "stale",
          error: result.error,
        });
      } else if (result.error) {
        failed++;
        results.push({
          entityId: entity.id,
          status: "failed",
          error: result.error,
        });
      } else if (result.updated) {
        refreshed++;
        results.push({
          entityId: entity.id,
          status: "updated",
        });
      } else if (result.hasLocalChanges) {
        skipped++;
        results.push({
          entityId: entity.id,
          status: "skipped",
          error: "Local changes detected - use force=true to overwrite",
        });
      } else {
        skipped++;
        results.push({
          entityId: entity.id,
          status: "skipped",
        });
      }
    } catch (error) {
      failed++;
      results.push({
        entityId: entity.id,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    refreshed,
    skipped,
    failed,
    stale,
    results,
  };
}

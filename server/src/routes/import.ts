import { importExternalSpec, type ExternalImportOptions } from "../services/external-import.js";
/**
 * Server routes for on-demand import functionality
 *
 * Provides API endpoints for importing entities from external systems
 * into sudocode specs via URL-based on-demand import.
 */

import { Router, Request, Response } from "express";
import { existsSync, readFileSync } from "fs";
import * as path from "path";
import type {
  IntegrationsConfig,
  ExternalEntity,
  ExternalLink,
  OnDemandImportCapable,
  IntegrationProvider,
} from "@sudocode-ai/types";
import {
  loadPlugin,
  getFirstPartyPlugins,
  testProviderConnection,
} from "@sudocode-ai/cli/dist/integrations/index.js";
import {
  findSpecsByExternalLink,
  findIssuesByExternalLink,
} from "@sudocode-ai/cli/dist/operations/external-links.js";
import { broadcastSpecUpdate } from "../services/websocket.js";
import {
  bulkRefresh,
  type BulkRefreshResult,
} from "../services/external-refresh-service.js";

/**
 * Provider information returned by GET /api/import/providers
 */
export interface ImportProviderInfo {
  name: string;
  displayName: string;
  supportsOnDemandImport: boolean;
  supportsSearch: boolean;
  urlPatterns: string[];
  configured: boolean;
  authMethod: "gh-cli" | "token" | "oauth" | "none";
}

/**
 * Preview response for POST /api/import/preview
 */
export interface ImportPreviewResponse {
  provider: string;
  entity: ExternalEntity;
  commentsCount?: number;
  alreadyLinked?: {
    entityId: string;
    entityType: "spec" | "issue";
    lastSyncedAt?: string;
  };
}

/**
 * Import request body for POST /api/import
 */
export interface ImportRequest {
  url: string;
  options?: ExternalImportOptions;
}

/**
 * Import response for POST /api/import
 */
export interface ImportResponse {
  entityId: string;
  entityType: "spec";
  externalLink: ExternalLink;
  feedbackCount?: number;
}

/**
 * Bulk refresh request body for POST /api/import/refresh
 */
export interface BulkRefreshRequest {
  /** Filter by provider name (optional) */
  provider?: string;
  /** Specific entity IDs to refresh (optional) */
  entityIds?: string[];
  /** Skip conflict check, overwrite local changes (default: false) */
  force?: boolean;
}

/**
 * Search request body for POST /api/import/search
 */
export interface ImportSearchRequest {
  /** Provider name to search (required) */
  provider: string;
  /** Search query (optional - if not provided, lists issues from repo) */
  query?: string;
  /** Repository to search in (e.g., "owner/repo") - used for listing without query */
  repo?: string;
  /** Page number for pagination (1-indexed, default: 1) */
  page?: number;
  /** Number of results per page (default: 20, max: 100) */
  perPage?: number;
}

/**
 * Search response for POST /api/import/search
 */
export interface ImportSearchResponse {
  provider: string;
  query?: string;
  repo?: string;
  results: ExternalEntity[];
  /** Pagination info */
  pagination?: {
    page: number;
    perPage: number;
    hasMore: boolean;
  };
}

/**
 * Batch import request body for POST /api/import/batch
 */
export interface BatchImportRequest {
  /** Provider name (required) */
  provider: string;
  /** Array of external IDs to import */
  externalIds: string[];
  /** Import options applied to all items */
  options?: ExternalImportOptions;
}

/**
 * Result for a single item in batch import
 */
export interface BatchImportItemResult {
  /** External ID that was imported */
  externalId: string;
  /** Whether the import succeeded */
  success: boolean;
  /** The sudocode entity ID (spec ID) */
  entityId?: string;
  /** Action taken: created, updated, or failed */
  action: "created" | "updated" | "failed";
  /** Error message if failed */
  error?: string;
}

/**
 * Batch import response for POST /api/import/batch
 */
export interface BatchImportResponse {
  /** Provider used */
  provider: string;
  /** Number of entities created */
  created: number;
  /** Number of entities updated */
  updated: number;
  /** Number of entities that failed */
  failed: number;
  /** Per-item results */
  results: BatchImportItemResult[];
}

/**
 * Helper to read config.json
 */
function readConfig(sudocodeDir: string): Record<string, unknown> {
  const configPath = path.join(sudocodeDir, "config.json");
  if (!existsSync(configPath)) {
    return {};
  }
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

/**
 * Check if a provider supports on-demand import
 */
function isOnDemandCapable(
  provider: IntegrationProvider
): provider is IntegrationProvider & OnDemandImportCapable {
  return provider.supportsOnDemandImport === true;
}

/**
 * Get URL patterns from a provider (if available)
 */
function getProviderUrlPatterns(provider: IntegrationProvider): string[] {
  if ("urlPatterns" in provider) {
    return (provider as unknown as { urlPatterns: string[] }).urlPatterns;
  }

  const defaultPatterns: Record<string, string[]> = {
    github: [
      "https://github.com/{owner}/{repo}/issues/{number}",
      "https://github.com/{owner}/{repo}/discussions/{number}",
    ],
    beads: ["beads://{workspace}/{id}"],
    jira: ["https://{domain}.atlassian.net/browse/{key}"],
  };

  return defaultPatterns[provider.name] || [];
}

/**
 * Determine auth method for a provider
 */
function getProviderAuthMethod(
  providerName: string
): "gh-cli" | "token" | "oauth" | "none" {
  const authMethods: Record<string, "gh-cli" | "token" | "oauth" | "none"> = {
    github: "gh-cli",
    jira: "token",
    beads: "none",
  };

  return authMethods[providerName] || "token";
}

export function createImportRouter(): Router {
  const router = Router();

  /**
   * GET /api/import/providers - List available import providers
   *
   * Returns all configured providers that support on-demand import
   */
  router.get("/providers", async (req: Request, res: Response) => {
    try {
      const firstPartyPlugins = getFirstPartyPlugins();
      const config = readConfig(req.project!.sudocodeDir);
      const integrations = (config.integrations || {}) as IntegrationsConfig;

      const providers: ImportProviderInfo[] = [];

      for (const p of firstPartyPlugins) {
        const providerConfig = integrations[p.name];
        const plugin = await loadPlugin(p.name);

        if (!plugin) {
          continue;
        }

        try {
          const provider = plugin.createProvider(
            providerConfig?.options || {},
            req.project!.path
          );

          if (provider.supportsOnDemandImport) {
            const testResult = await testProviderConnection(
              p.name,
              providerConfig || { enabled: false },
              req.project!.path
            );

            providers.push({
              name: p.name,
              displayName: plugin.displayName,
              supportsOnDemandImport: true,
              supportsSearch: provider.supportsSearch,
              urlPatterns: getProviderUrlPatterns(provider),
              configured: testResult.configured,
              authMethod: getProviderAuthMethod(p.name),
            });
          }
        } catch (error) {
          console.warn(`[import] Failed to create provider ${p.name}:`, error);
        }
      }

      const firstPartyNames = new Set(firstPartyPlugins.map((p) => p.name));
      for (const [name, providerConfig] of Object.entries(integrations)) {
        if (!firstPartyNames.has(name) && providerConfig) {
          const pluginId = providerConfig.plugin || name;
          const plugin = await loadPlugin(pluginId);

          if (!plugin) {
            continue;
          }

          try {
            const provider = plugin.createProvider(
              providerConfig.options || {},
              req.project!.path
            );

            if (provider.supportsOnDemandImport) {
              const testResult = await testProviderConnection(
                name,
                providerConfig,
                req.project!.path
              );

              providers.push({
                name,
                displayName: plugin.displayName,
                supportsOnDemandImport: true,
                supportsSearch: provider.supportsSearch,
                urlPatterns: getProviderUrlPatterns(provider),
                configured: testResult.configured,
                authMethod: getProviderAuthMethod(name),
              });
            }
          } catch (error) {
            console.warn(
              `[import] Failed to create custom provider ${name}:`,
              error
            );
          }
        }
      }

      res.status(200).json({
        success: true,
        data: { providers },
      });
    } catch (error) {
      console.error("[import] Failed to list providers:", error);
      res.status(500).json({
        success: false,
        error: "Failed to list import providers",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * POST /api/import/preview - Preview an import before creating entity
   *
   * Fetches entity from external system and checks if already imported
   */
  router.post("/preview", async (req: Request, res: Response) => {
    try {
      const { url } = req.body as { url?: string };

      if (!url || typeof url !== "string") {
        res.status(400).json({
          success: false,
          error: "URL is required",
          message: "Request body must include a valid URL string",
        });
        return;
      }

      const config = readConfig(req.project!.sudocodeDir);
      const integrations = (config.integrations || {}) as IntegrationsConfig;
      const firstPartyPlugins = getFirstPartyPlugins();

      let matchedProvider: IntegrationProvider | null = null;
      let matchedProviderName: string | null = null;

      for (const p of firstPartyPlugins) {
        const plugin = await loadPlugin(p.name);
        if (!plugin) continue;

        const providerConfig = integrations[p.name];
        const provider = plugin.createProvider(
          providerConfig?.options || {},
          req.project!.path
        );

        if (isOnDemandCapable(provider) && provider.canHandleUrl?.(url)) {
          matchedProvider = provider;
          matchedProviderName = p.name;
          break;
        }
      }

      if (!matchedProvider) {
        const firstPartyNames = new Set(firstPartyPlugins.map((p) => p.name));
        for (const [name, providerConfig] of Object.entries(integrations)) {
          if (!firstPartyNames.has(name) && providerConfig) {
            const pluginId = providerConfig.plugin || name;
            const plugin = await loadPlugin(pluginId);
            if (!plugin) continue;

            const provider = plugin.createProvider(
              providerConfig.options || {},
              req.project!.path
            );

            if (isOnDemandCapable(provider) && provider.canHandleUrl?.(url)) {
              matchedProvider = provider;
              matchedProviderName = name;
              break;
            }
          }
        }
      }

      if (!matchedProvider || !matchedProviderName) {
        res.status(422).json({
          success: false,
          error: "No provider found",
          message: `No configured provider can handle URL: ${url}`,
        });
        return;
      }

      await matchedProvider.initialize();

      const entity = isOnDemandCapable(matchedProvider)
        ? await matchedProvider.fetchByUrl?.(url)
        : null;

      if (!entity) {
        res.status(404).json({
          success: false,
          error: "Entity not found",
          message: `Could not fetch entity from URL: ${url}`,
        });
        return;
      }

      let alreadyLinked: ImportPreviewResponse["alreadyLinked"] | undefined;

      const existingSpecs = findSpecsByExternalLink(
        req.project!.sudocodeDir,
        matchedProviderName,
        entity.id
      );

      if (existingSpecs.length > 0) {
        const existingSpec = existingSpecs[0];
        const link = existingSpec.external_links?.find(
          (l) =>
            l.provider === matchedProviderName && l.external_id === entity.id
        );

        alreadyLinked = {
          entityId: existingSpec.id,
          entityType: "spec",
          lastSyncedAt: link?.last_synced_at,
        };
      } else {
        const existingIssues = findIssuesByExternalLink(
          req.project!.sudocodeDir,
          matchedProviderName,
          entity.id
        );

        if (existingIssues.length > 0) {
          const existingIssue = existingIssues[0];
          const link = existingIssue.external_links?.find(
            (l) =>
              l.provider === matchedProviderName && l.external_id === entity.id
          );

          alreadyLinked = {
            entityId: existingIssue.id,
            entityType: "issue",
            lastSyncedAt: link?.last_synced_at,
          };
        }
      }

      let commentsCount: number | undefined;
      if (isOnDemandCapable(matchedProvider) && matchedProvider.fetchComments) {
        try {
          const comments = await matchedProvider.fetchComments(entity.id);
          commentsCount = comments.length;
        } catch {
        }
      }

      await matchedProvider.dispose();

      const response: ImportPreviewResponse = {
        provider: matchedProviderName,
        entity,
        commentsCount,
        alreadyLinked,
      };

      res.status(200).json({
        success: true,
        data: response,
      });
    } catch (error) {
      console.error("[import] Preview failed:", error);

      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (
        errorMessage.includes("not authenticated") ||
        errorMessage.includes("auth")
      ) {
        res.status(401).json({
          success: false,
          error: "Authentication required",
          message: errorMessage,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: "Preview failed",
        message: errorMessage,
      });
    }
  });

  /**
   * POST /api/import/search - Search for entities in external systems
   *
   * Searches a provider for entities matching a query, or lists issues from a repo
   */
  router.post("/search", async (req: Request, res: Response) => {
    try {
      const {
        provider: providerName,
        query,
        repo,
        page = 1,
        perPage = 20,
      } = req.body as ImportSearchRequest;

      if (!providerName || typeof providerName !== "string") {
        res.status(400).json({
          success: false,
          error: "Provider is required",
          message: "Request body must include a valid provider name",
        });
        return;
      }

      if (!query && !repo) {
        res.status(400).json({
          success: false,
          error: "Query or repo is required",
          message:
            "Request body must include a search query or repo to list issues from",
        });
        return;
      }

      const config = readConfig(req.project!.sudocodeDir);
      const integrations = (config.integrations || {}) as IntegrationsConfig;

      const plugin = await loadPlugin(providerName);

      if (!plugin) {
        res.status(404).json({
          success: false,
          error: "Provider not found",
          message: `Provider "${providerName}" is not installed`,
        });
        return;
      }

      const providerConfig = integrations[providerName];
      const provider = plugin.createProvider(
        providerConfig?.options || {},
        req.project!.path
      );

      if (!provider.supportsSearch) {
        res.status(422).json({
          success: false,
          error: "Search not supported",
          message: `Provider "${providerName}" does not support search`,
        });
        return;
      }

      await provider.initialize();

      const searchResult = await provider.searchEntities(query, {
        repo,
        page,
        perPage: Math.min(perPage, 100),
      });

      await provider.dispose();

      const isSearchResult =
        searchResult &&
        typeof searchResult === "object" &&
        "results" in searchResult;
      const results = isSearchResult
        ? (searchResult as { results: ExternalEntity[] }).results
        : (searchResult as ExternalEntity[]);
      const pagination = isSearchResult
        ? (searchResult as { pagination?: ImportSearchResponse["pagination"] })
            .pagination
        : undefined;

      const response: ImportSearchResponse = {
        provider: providerName,
        query,
        repo,
        results,
        pagination,
      };

      res.status(200).json({
        success: true,
        data: response,
      });
    } catch (error) {
      console.error("[import] Search failed:", error);

      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (
        errorMessage.includes("not authenticated") ||
        errorMessage.includes("auth")
      ) {
        res.status(401).json({
          success: false,
          error: "Authentication required",
          message: errorMessage,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: "Search failed",
        message: errorMessage,
      });
    }
  });

  /**
   * POST /api/import/batch - Batch import entities with upsert behavior
   *
   * Creates or updates specs from external entities. If an entity is already
   * imported, it updates the existing spec instead of creating a duplicate.
   */
  router.post("/batch", async (req: Request, res: Response) => {
    try {
      const {
        provider: providerName,
        externalIds,
        options = {},
      } = req.body as BatchImportRequest;

      if (!providerName || typeof providerName !== "string") {
        res.status(400).json({
          success: false,
          error: "Provider is required",
          message: "Request body must include a valid provider name",
        });
        return;
      }

      if (!Array.isArray(externalIds) || externalIds.length === 0) {
        res.status(400).json({
          success: false,
          error: "External IDs required",
          message: "Request body must include a non-empty array of external IDs",
        });
        return;
      }

      const config = readConfig(req.project!.sudocodeDir);
      const integrations = (config.integrations || {}) as IntegrationsConfig;

      const plugin = await loadPlugin(providerName);
      if (!plugin) {
        res.status(404).json({
          success: false,
          error: "Provider not found",
          message: `Provider "${providerName}" is not installed`,
        });
        return;
      }

      const providerConfig = integrations[providerName];
      const provider = plugin.createProvider(
        providerConfig?.options || {},
        req.project!.path
      );

      if (!isOnDemandCapable(provider)) {
        res.status(422).json({
          success: false,
          error: "Import not supported",
          message: `Provider "${providerName}" does not support on-demand import`,
        });
        return;
      }

      await provider.initialize();

      const results: BatchImportItemResult[] = [];
      let created = 0;
      let updated = 0;
      let failed = 0;

      for (const externalId of externalIds) {
        try {
          const entity = await provider.fetchEntity(externalId);

          if (!entity) {
            results.push({
              externalId,
              success: false,
              action: "failed",
              error: "Entity not found",
            });
            failed++;
            continue;
          }

          const comments = options.includeComments && provider.fetchComments
            ? await provider.fetchComments(entity.id) : undefined;
          const imported = importExternalSpec(req.project!.db, req.project!.sudocodeDir,
            providerName, entity, comments, options, true);
          broadcastSpecUpdate(req.project!.id, imported.spec.id, imported.action, imported.spec);
          results.push({ externalId, success: true, entityId: imported.spec.id, action: imported.action });
          if (imported.action === "created") created++;
          else updated++;
        } catch (itemError) {
          const errorMessage =
            itemError instanceof Error ? itemError.message : String(itemError);
          results.push({
            externalId,
            success: false,
            action: "failed",
            error: errorMessage,
          });
          failed++;
        }
      }

      await provider.dispose();

      const response: BatchImportResponse = {
        provider: providerName,
        created,
        updated,
        failed,
        results,
      };

      res.status(200).json({
        success: true,
        data: response,
      });
    } catch (error) {
      console.error("[import] Batch import failed:", error);

      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (
        errorMessage.includes("not authenticated") ||
        errorMessage.includes("auth")
      ) {
        res.status(401).json({
          success: false,
          error: "Authentication required",
          message: errorMessage,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: "Batch import failed",
        message: errorMessage,
      });
    }
  });

  /**
   * POST /api/import - Import entity and create spec
   *
   * Creates a spec with external_link from the given URL
   */
  router.post("/", async (req: Request, res: Response) => {
    try {
      const { url, options = {} } = req.body as ImportRequest;

      if (!url || typeof url !== "string") {
        res.status(400).json({
          success: false,
          error: "URL is required",
          message: "Request body must include a valid URL string",
        });
        return;
      }

      const config = readConfig(req.project!.sudocodeDir);
      const integrations = (config.integrations || {}) as IntegrationsConfig;
      const firstPartyPlugins = getFirstPartyPlugins();

      let matchedProvider: IntegrationProvider | null = null;
      let matchedProviderName: string | null = null;

      for (const p of firstPartyPlugins) {
        const plugin = await loadPlugin(p.name);
        if (!plugin) continue;

        const providerConfig = integrations[p.name];
        const provider = plugin.createProvider(
          providerConfig?.options || {},
          req.project!.path
        );

        if (isOnDemandCapable(provider) && provider.canHandleUrl?.(url)) {
          matchedProvider = provider;
          matchedProviderName = p.name;
          break;
        }
      }

      if (!matchedProvider) {
        const firstPartyNames = new Set(firstPartyPlugins.map((p) => p.name));
        for (const [name, providerConfig] of Object.entries(integrations)) {
          if (!firstPartyNames.has(name) && providerConfig) {
            const pluginId = providerConfig.plugin || name;
            const plugin = await loadPlugin(pluginId);
            if (!plugin) continue;

            const provider = plugin.createProvider(
              providerConfig.options || {},
              req.project!.path
            );

            if (isOnDemandCapable(provider) && provider.canHandleUrl?.(url)) {
              matchedProvider = provider;
              matchedProviderName = name;
              break;
            }
          }
        }
      }

      if (!matchedProvider || !matchedProviderName) {
        res.status(422).json({
          success: false,
          error: "No provider found",
          message: `No configured provider can handle URL: ${url}`,
        });
        return;
      }

      await matchedProvider.initialize();

      const entity = isOnDemandCapable(matchedProvider)
        ? await matchedProvider.fetchByUrl?.(url)
        : null;

      if (!entity) {
        res.status(404).json({
          success: false,
          error: "Entity not found",
          message: `Could not fetch entity from URL: ${url}`,
        });
        return;
      }

      const existingSpecs = findSpecsByExternalLink(
        req.project!.sudocodeDir,
        matchedProviderName,
        entity.id
      );

      if (existingSpecs.length > 0) {
        res.status(409).json({
          success: false,
          error: "Already imported",
          message: `Entity already imported as spec: ${existingSpecs[0].id}`,
          data: {
            entityId: existingSpecs[0].id,
            entityType: "spec",
          },
        });
        return;
      }

      const comments = options.includeComments && isOnDemandCapable(matchedProvider) && matchedProvider.fetchComments
        ? await matchedProvider.fetchComments(entity.id) : undefined;
      const { spec, externalLink, feedbackCount } = importExternalSpec(
        req.project!.db, req.project!.sudocodeDir, matchedProviderName, entity, comments, options, false
      );

      await matchedProvider.dispose();

      broadcastSpecUpdate(req.project!.id, spec.id, "created", spec);

      const response: ImportResponse = {
        entityId: spec.id,
        entityType: "spec",
        externalLink,
        feedbackCount,
      };

      res.status(201).json({
        success: true,
        data: response,
      });
    } catch (error) {
      console.error("[import] Import failed:", error);

      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (
        errorMessage.includes("not authenticated") ||
        errorMessage.includes("auth")
      ) {
        res.status(401).json({
          success: false,
          error: "Authentication required",
          message: errorMessage,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: "Import failed",
        message: errorMessage,
      });
    }
  });

  router.post("/refresh", async (req: Request, res: Response) => {
    try {
      const { provider, entityIds, force } = req.body as BulkRefreshRequest;

      if (entityIds !== undefined) {
        if (!Array.isArray(entityIds)) {
          res.status(400).json({
            success: false,
            error: "Invalid request",
            message: "entityIds must be an array of strings",
          });
          return;
        }

        if (!entityIds.every((id) => typeof id === "string")) {
          res.status(400).json({
            success: false,
            error: "Invalid request",
            message: "entityIds must contain only strings",
          });
          return;
        }
      }

      if (provider !== undefined && typeof provider !== "string") {
        res.status(400).json({
          success: false,
          error: "Invalid request",
          message: "provider must be a string",
        });
        return;
      }

      const result: BulkRefreshResult = await bulkRefresh(
        req.project!.db,
        req.project!.sudocodeDir,
        req.project!.path,
        {
          provider,
          entityIds,
          force: force === true,
        }
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      console.error("[import] Bulk refresh failed:", error);

      const errorMessage =
        error instanceof Error ? error.message : String(error);

      res.status(500).json({
        success: false,
        error: "Bulk refresh failed",
        message: errorMessage,
      });
    }
  });

  return router;
}

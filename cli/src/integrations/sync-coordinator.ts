/**
 * SyncCoordinator - Orchestrates sync between sudocode and external integration providers
 *
 * Manages provider lifecycle, handles change detection, and resolves conflicts
 * during bidirectional synchronization.
 */

import type {
  IntegrationConfig,
  IntegrationsConfig,
  ExternalChange,
  ExternalLink,
  SyncResult,
  SyncConflict,
  SyncDirection,
  IntegrationProviderName,
  Spec,
  Issue,
  SpecJSONL,
  IssueJSONL,
} from "@sudocode-ai/types";
import type { IntegrationProvider } from "./types.js";
import { resolveByStrategy, logConflict } from "./utils/conflict-resolver.js";
import { IntegrationTracker } from "./tracker.js";
import {
  findSpecsByExternalLink,
  findIssuesByExternalLink,
  getSpecFromJsonl,
  getIssueFromJsonl,
} from "../operations/external-links.js";

/**
 * Options for creating a SyncCoordinator
 */
export interface SyncCoordinatorOptions {
  /** Project root path (where .sudocode is located) */
  projectPath: string;
  /** Integration configurations */
  config: IntegrationsConfig;
  /** Custom conflict resolution callback (for manual resolution) */
  onConflict?: (
    conflict: SyncConflict,
  ) => Promise<"sudocode" | "external" | "skip">;
}

/**
 * Entity union type for specs and issues
 */
type Entity = Spec | Issue;
type EntityJSONL = SpecJSONL | IssueJSONL;

/**
 * SyncCoordinator manages integration providers and synchronization
 *
 * @example
 * ```typescript
 * const coordinator = new SyncCoordinator({
 *   projectPath: '/path/to/project',
 *   config: { jira: { enabled: true, ... } },
 * });
 *
 * coordinator.registerProvider(new JiraProvider());
 * await coordinator.start();
 *
 * // Sync all providers
 * const results = await coordinator.syncAll();
 *
 * // Link a sudocode entity to an external entity
 * await coordinator.linkEntity('i-abc', 'PROJ-123', 'jira');
 *
 * await coordinator.stop();
 * ```
 */
export class SyncCoordinator {
  private providers = new Map<string, IntegrationProvider>();
  private lastSyncTimes = new Map<string, Date>();

  private tracker: IntegrationTracker;

  constructor(private options: SyncCoordinatorOptions) {
    this.tracker = new IntegrationTracker(options.projectPath);
  }

  /**
   * Register an integration provider
   * @param provider - The provider to register
   */
  registerProvider(provider: IntegrationProvider): void {
    this.providers.set(provider.name, provider);
  }

  /**
   * Get a registered provider by name
   * @param name - Provider name
   * @returns The provider, or undefined if not found
   */
  getProvider(name: string): IntegrationProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * Get all registered provider names
   */
  getProviderNames(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Start the coordinator and initialize all enabled providers
   *
   * For each registered provider:
   * 1. Skip if not enabled in config
   * 2. Initialize with config
   * 3. Validate connection
   * 4. Start watching if auto_sync is enabled and provider supports it
   */
  async start(): Promise<void> {
    for (const [name, provider] of this.providers) {
      const config = this.getProviderConfig(name);

      if (!config?.enabled) continue;

      try {
        await provider.initialize(config);

        const validation = await provider.validate();
        if (!validation.valid) {
          console.warn(
            `[sync-coordinator] Provider ${name} validation failed:`,
            validation.errors,
          );
          continue;
        }

        if (
          config.auto_sync &&
          provider.supportsWatch &&
          provider.startWatching
        ) {
          provider.startWatching((changes) => {
            this.handleInboundChanges(name, changes);
          });
        }

        this.lastSyncTimes.set(name, new Date());
      } catch (error) {
        console.error(
          `[sync-coordinator] Failed to initialize provider ${name}:`,
          error,
        );
      }
    }
  }

  /**
   * Stop the coordinator and dispose all providers
   */
  async stop(): Promise<void> {
    for (const [_name, provider] of this.providers) {
      try {
        provider.stopWatching?.();
        await provider.dispose();
      } catch (error) {
        console.error(`Error disposing provider ${_name}:`, error);
      }
    }
  }

  /**
   * Sync all registered and enabled providers
   * @returns Array of sync results from all providers
   */
  async syncAll(): Promise<SyncResult[]> {
    const results: SyncResult[] = [];

    for (const name of this.providers.keys()) {
      const config = this.getProviderConfig(name);
      if (!config?.enabled) continue;

      try {
        const providerResults = await this.syncProvider(name);
        results.push(...providerResults);
      } catch (error) {
        results.push({
          success: false,
          entity_id: "",
          external_id: "",
          action: "skipped",
          error: `Provider ${name} sync failed: ${String(error)}`,
        });
      }
    }

    return results;
  }

  /**
   * Sync a specific provider
   * @param providerName - Name of the provider to sync
   * @returns Array of sync results
   */
  async syncProvider(providerName: string): Promise<SyncResult[]> {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Unknown provider: ${providerName}`);
    }

    const lastSync = this.lastSyncTimes.get(providerName) || new Date(0);
    const changes = await provider.getChangesSince(lastSync);

    const results = await this.handleInboundChanges(providerName, changes);
    this.lastSyncTimes.set(providerName, new Date());

    return results;
  }

  /**
   * Sync a specific entity's external links
   * @param entityId - Sudocode entity ID (s-xxxx or i-xxxx)
   * @returns Array of sync results for each link
   */
  async syncEntity(entityId: string): Promise<SyncResult[]> {
    const entity = this.loadEntity(entityId);

    if (!entity?.external_links?.length) {
      return [
        {
          success: true,
          entity_id: entityId,
          external_id: "",
          action: "skipped",
        },
      ];
    }

    const results: SyncResult[] = [];
    for (const link of entity.external_links) {
      if (!link.sync_enabled) continue;

      try {
        const result = await this.syncSingleLink(entity, link);
        results.push(result);
      } catch (error) {
        results.push({
          success: false,
          entity_id: entityId,
          external_id: link.external_id,
          action: "skipped",
          error: String(error),
        });
      }
    }

    return results;
  }

  /**
   * Link a sudocode entity to an external entity
   *
   * @param entityId - Sudocode entity ID
   * @param externalId - External system entity ID
   * @param provider - Provider name
   * @param options - Link options (sync direction, enabled)
   */
  async linkEntity(
    entityId: string,
    externalId: string,
    provider: string,
    options?: { sync_direction?: SyncDirection; sync_enabled?: boolean },
  ): Promise<void> {
    const entity = this.loadEntity(entityId);
    if (!entity) {
      throw new Error(`Entity not found: ${entityId}`);
    }

    const link: ExternalLink = {
      provider: provider as IntegrationProviderName,
      external_id: externalId,
      sync_enabled: options?.sync_enabled ?? true,
      sync_direction: options?.sync_direction ?? "bidirectional",
      last_synced_at: new Date().toISOString(),
    };

    const links = entity.external_links || [];

    const existingIndex = links.findIndex(
      (l) => l.provider === provider && l.external_id === externalId,
    );

    if (existingIndex >= 0) {
      links[existingIndex] = { ...links[existingIndex], ...link };
    } else {
      links.push(link);
    }

    this.tracker.update(entityId, { external_links: links });
  }

  /**
   * Remove a link between a sudocode entity and an external entity
   *
   * @param entityId - Sudocode entity ID
   * @param externalId - External system entity ID
   */
  async unlinkEntity(entityId: string, externalId: string): Promise<void> {
    const entity = this.loadEntity(entityId);
    if (!entity?.external_links) return;

    const links = entity.external_links.filter(
      (l) => l.external_id !== externalId,
    );
    this.tracker.update(entityId, { external_links: links });
  }

  /**
   * Handle deletion of a sudocode entity - propagate to external systems
   *
   * Call this when a sudocode entity is deleted to propagate the deletion
   * to all linked external systems.
   *
   * @param entityId - Sudocode entity ID that was deleted
   * @param externalLinks - The external_links from the deleted entity
   * @returns Array of sync results
   */
  async handleEntityDeleted(
    entityId: string,
    externalLinks: ExternalLink[],
  ): Promise<SyncResult[]> {
    const results: SyncResult[] = [];

    if (!externalLinks || externalLinks.length === 0) {
      return results;
    }

    for (const link of externalLinks) {
      if (!link.sync_enabled) continue;
      if (link.sync_direction === "inbound") continue;

      const provider = this.providers.get(link.provider);
      if (!provider) continue;

      const config = this.getProviderConfig(link.provider);
      const deleteBehavior = config?.delete_behavior || "close";

      try {
        if (deleteBehavior === "delete" && provider.deleteEntity) {
          await provider.deleteEntity(link.external_id);
          results.push({
            success: true,
            entity_id: entityId,
            external_id: link.external_id,
            action: "updated",
          });
        } else if (deleteBehavior === "close" && provider.updateEntity) {
          await provider.updateEntity(link.external_id, {
            status: "closed",
          } as Partial<Issue>);
          results.push({
            success: true,
            entity_id: entityId,
            external_id: link.external_id,
            action: "updated",
          });
        } else {
          results.push({
            success: true,
            entity_id: entityId,
            external_id: link.external_id,
            action: "skipped",
          });
        }
      } catch (error) {
        results.push({
          success: false,
          entity_id: entityId,
          external_id: link.external_id,
          action: "skipped",
          error: String(error),
        });
      }
    }

    return results;
  }

  /**
   * Handle inbound changes from an external provider
   */
  private async handleInboundChanges(
    providerName: string,
    changes: ExternalChange[],
  ): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    const provider = this.providers.get(providerName);
    if (!provider) {
      return results;
    }

    for (const change of changes) {
      try {
        const result = await this.processInboundChange(
          providerName,
          provider,
          change,
        );
        results.push(result);
      } catch (error) {
        results.push({
          success: false,
          entity_id: "",
          external_id: change.entity_id,
          action: "skipped",
          error: String(error),
        });
      }
    }

    return results;
  }

  /**
   * Process a single inbound change
   */
  private async processInboundChange(
    providerName: string,
    provider: IntegrationProvider,
    change: ExternalChange,
  ): Promise<SyncResult> {
    const config = this.getProviderConfig(providerName);

    const linkedEntity = this.findLinkedEntity(providerName, change.entity_id);

    if (!linkedEntity && change.change_type === "created") {
      const autoImport = config?.auto_import !== false;

      if (autoImport && change.data) {
        const mapped = provider.mapToSudocode(change.data);
        const created = this.tracker.create(change.data, mapped, {
          provider: providerName,
          external_id: change.entity_id,
          sync_enabled: true,
          sync_direction: config?.default_sync_direction ?? "bidirectional",
          last_synced_at: new Date().toISOString(),
        });
        return {
          success: true,
          entity_id: created.id,
          external_id: change.entity_id,
          action: "created",
        };
      }

      return {
        success: true,
        entity_id: "",
        external_id: change.entity_id,
        action: "skipped",
      };
    }

    if (!linkedEntity && change.change_type === "updated") {
      return {
        success: true,
        entity_id: "",
        external_id: change.entity_id,
        action: "skipped",
      };
    }

    if (change.change_type === "deleted") {
      if (!linkedEntity) {
        return {
          success: true,
          entity_id: "",
          external_id: change.entity_id,
          action: "skipped",
        };
      }

      const deleteBehavior = config?.delete_behavior || "close";

      if (deleteBehavior === "ignore") {
        this.tracker.update(linkedEntity.id, {
          external_links: linkedEntity.external_links?.map((link) =>
            link.external_id === change.entity_id
              ? { ...link, sync_enabled: false }
              : link,
          ),
        });
        return {
          success: true,
          entity_id: linkedEntity.id,
          external_id: change.entity_id,
          action: "skipped",
        };
      }

      if (deleteBehavior === "delete") {
        this.tracker.delete(linkedEntity.id);
        return {
          success: true,
          entity_id: linkedEntity.id,
          external_id: change.entity_id,
          action: "updated",
        };
      }

      if (!("status" in linkedEntity))
        throw new Error(`${linkedEntity.id}.status: only issues can be closed`);
      this.tracker.update(linkedEntity.id, {
        status: "closed",
        external_links: linkedEntity.external_links?.filter(
          (link) => link.external_id !== change.entity_id,
        ),
      });
      return {
        success: true,
        entity_id: linkedEntity.id,
        external_id: change.entity_id,
        action: "updated",
      };
    }

    const link = linkedEntity?.external_links?.find(
      (l) => l.external_id === change.entity_id,
    );

    if (link && change.data?.updated_at && linkedEntity) {
      const conflict = this.detectConflict(linkedEntity, change, link);
      if (conflict) {
        const resolution = await this.resolveConflict(conflict);

        if (resolution === "skip") {
          return {
            success: true,
            entity_id: linkedEntity.id,
            external_id: change.entity_id,
            action: "skipped",
          };
        }

        if (resolution === "sudocode") {
          await provider.updateEntity(change.entity_id, linkedEntity);
          this.tracker.update(linkedEntity.id, {}, link.external_id);
          return {
            success: true,
            entity_id: linkedEntity.id,
            external_id: change.entity_id,
            action: "updated",
          };
        }
      }
    }

    if (change.data && linkedEntity) {
      const mapped = provider.mapToSudocode(change.data);
      const updates = mapped.spec || mapped.issue;

      if (updates) {
        this.tracker.update(linkedEntity.id, updates, link?.external_id);
        return {
          success: true,
          entity_id: linkedEntity.id,
          external_id: change.entity_id,
          action: "updated",
        };
      }
    }

    return {
      success: true,
      entity_id: linkedEntity?.id || "",
      external_id: change.entity_id,
      action: "skipped",
    };
  }

  /**
   * Sync a single external link
   */
  private async syncSingleLink(
    entity: Entity,
    link: ExternalLink,
  ): Promise<SyncResult> {
    const provider = this.providers.get(link.provider);
    if (!provider) {
      return {
        success: false,
        entity_id: entity.id,
        external_id: link.external_id,
        action: "skipped",
        error: `Provider not registered: ${link.provider}`,
      };
    }

    try {
      const externalEntity = await provider.fetchEntity(link.external_id);
      if (!externalEntity) {
        return {
          success: false,
          entity_id: entity.id,
          external_id: link.external_id,
          action: "skipped",
          error: "External entity not found",
        };
      }

      const change: ExternalChange = {
        entity_id: link.external_id,
        entity_type: externalEntity.type,
        change_type: "updated",
        timestamp: externalEntity.updated_at || new Date().toISOString(),
        data: externalEntity,
      };

      const conflict = this.detectConflict(entity, change, link);

      if (conflict) {
        const resolution = await this.resolveConflict(conflict);

        if (resolution === "skip") {
          return {
            success: true,
            entity_id: entity.id,
            external_id: link.external_id,
            action: "skipped",
          };
        }

        if (resolution === "sudocode") {
          await provider.updateEntity(link.external_id, entity);
          this.tracker.update(entity.id, {}, link.external_id);
          return {
            success: true,
            entity_id: entity.id,
            external_id: link.external_id,
            action: "updated",
          };
        }

        const mapped = provider.mapToSudocode(externalEntity);
        const updates = mapped.spec || mapped.issue;
        this.tracker.update(entity.id, updates ?? {}, link.external_id);
        return {
          success: true,
          entity_id: entity.id,
          external_id: link.external_id,
          action: "updated",
        };
      }

      if (
        link.sync_direction === "outbound" ||
        link.sync_direction === "bidirectional"
      ) {
        await provider.updateEntity(link.external_id, entity);
      }

      this.tracker.update(entity.id, {}, link.external_id);
      return {
        success: true,
        entity_id: entity.id,
        external_id: link.external_id,
        action: "updated",
      };
    } catch (error) {
      console.error(`[sync-coordinator] syncSingleLink error:`, error);
      return {
        success: false,
        entity_id: entity.id,
        external_id: link.external_id,
        action: "skipped",
        error: String(error),
      };
    }
  }

  /**
   * Detect if there's a conflict between sudocode and external versions
   */
  private detectConflict(
    entity: Entity,
    change: ExternalChange,
    link: ExternalLink,
  ): SyncConflict | null {
    const sudocodeUpdated = new Date(entity.updated_at);
    const externalUpdated = new Date(change.data?.updated_at || 0);
    const lastSynced = link.last_synced_at
      ? new Date(link.last_synced_at)
      : new Date(0);

    if (sudocodeUpdated > lastSynced && externalUpdated > lastSynced) {
      return {
        sudocode_entity_id: entity.id,
        external_id: change.entity_id,
        provider: link.provider,
        sudocode_updated_at: entity.updated_at,
        external_updated_at: change.data?.updated_at || "",
      };
    }

    return null;
  }

  /**
   * Resolve a sync conflict based on configured strategy
   */
  private async resolveConflict(
    conflict: SyncConflict,
  ): Promise<"sudocode" | "external" | "skip"> {
    const config = this.getProviderConfig(conflict.provider);
    const strategy = config?.conflict_resolution || "newest-wins";

    if (strategy === "manual" && this.options.onConflict) {
      const resolution = await this.options.onConflict(conflict);
      logConflict({
        timestamp: new Date().toISOString(),
        conflict,
        resolution,
        strategy,
      });
      return resolution;
    }

    const resolution = resolveByStrategy(conflict, strategy);
    logConflict({
      timestamp: new Date().toISOString(),
      conflict,
      resolution,
      strategy,
    });
    return resolution;
  }

  /**
   * Get provider config from options
   */
  private getProviderConfig(name: string): IntegrationConfig | undefined {
    return this.options.config[name as keyof IntegrationsConfig] as
      | IntegrationConfig
      | undefined;
  }

  private loadEntity(id: string): Entity | null {
    const sudocodeDir = this.tracker.directory;
    let jsonlEntity: EntityJSONL | null = null;

    if (id.startsWith("s-")) {
      jsonlEntity = getSpecFromJsonl(sudocodeDir, id);
    } else {
      jsonlEntity = getIssueFromJsonl(sudocodeDir, id);
    }

    if (!jsonlEntity) return null;
    return this.toEntity(jsonlEntity);
  }

  /**
   * Convert JSONL entity to domain Entity
   */
  private toEntity(jsonl: EntityJSONL): Entity {
    const { relationships, tags, feedback, ...entityData } = jsonl as any;
    return entityData as Entity;
  }

  /**
   * Find a sudocode entity linked to an external entity
   */
  private findLinkedEntity(
    provider: string,
    externalId: string,
  ): Entity | null {
    const sudocodeDir = this.tracker.directory;
    const providerName = provider as IntegrationProviderName;

    const specs = findSpecsByExternalLink(
      sudocodeDir,
      providerName,
      externalId,
    );
    if (specs.length > 0) {
      return this.toEntity(specs[0]);
    }

    const issues = findIssuesByExternalLink(
      sudocodeDir,
      providerName,
      externalId,
    );
    if (issues.length > 0) {
      return this.toEntity(issues[0]);
    }

    return null;
  }
}

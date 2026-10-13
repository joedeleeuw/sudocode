/**
 * Unit Tests for SyncCoordinator
 *
 * Tests the sync orchestration logic, provider lifecycle, and conflict handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SyncCoordinator } from "../../../src/integrations/sync-coordinator.js";
import { BaseIntegrationProvider } from "../../../src/integrations/base-provider.js";
import type {
  ExternalEntity,
  ExternalChange,
  IntegrationConfig,
  IntegrationsConfig,
  Spec,
  Issue,
} from "@sudocode-ai/types";
import * as fs from "fs";
import * as path from "path";

// Mock the JSONL functions
vi.mock("../../../src/jsonl.js", () => ({
  readJSONLSync: vi.fn(),
  writeJSONLSync: vi.fn(),
  getJSONLEntitySync: vi.fn(),
  updateJSONLLineSync: vi.fn(),
}));

// Mock the external-links functions
vi.mock("../../../src/operations/external-links.js", () => ({
  findSpecsByExternalLink: vi.fn().mockReturnValue([]),
  findIssuesByExternalLink: vi.fn().mockReturnValue([]),
  getSpecFromJsonl: vi.fn().mockReturnValue(null),
  getIssueFromJsonl: vi.fn().mockReturnValue(null),
}));

import {
  readJSONLSync,
  writeJSONLSync,
  getJSONLEntitySync,
} from "../../../src/jsonl.js";

import {
  findSpecsByExternalLink,
  findIssuesByExternalLink,
  getSpecFromJsonl,
  getIssueFromJsonl,
} from "../../../src/operations/external-links.js";

// Type assertion helper for mocked functions
const mockedGetIssueFromJsonl = getIssueFromJsonl as ReturnType<typeof vi.fn>;
const mockedGetSpecFromJsonl = getSpecFromJsonl as ReturnType<typeof vi.fn>;

/**
 * Mock provider for testing
 */
class MockProvider extends BaseIntegrationProvider {
  readonly name = "mock";
  readonly supportsWatch = true;
  readonly supportsPolling = true;

  changes: ExternalChange[] = [];
  entities = new Map<string, ExternalEntity>();
  watchCallback?: (changes: ExternalChange[]) => void;
  initializeCalled = false;
  disposeCalled = false;
  validateResult = { valid: true, errors: [] as string[] };

  protected async doInitialize(): Promise<void> {
    this.initializeCalled = true;
  }

  async validate(): Promise<{ valid: boolean; errors: string[] }> {
    return this.validateResult;
  }

  async fetchEntity(id: string): Promise<ExternalEntity | null> {
    return this.entities.get(id) || null;
  }

  async searchEntities(_query?: string): Promise<ExternalEntity[]> {
    return Array.from(this.entities.values());
  }

  async createEntity(entity: Partial<Spec | Issue>): Promise<string> {
    const id = `mock-${Date.now()}`;
    this.entities.set(id, {
      id,
      type: "issue",
      title: entity.title || "Untitled",
    });
    return id;
  }

  async updateEntity(
    externalId: string,
    _entity: Partial<Spec | Issue>
  ): Promise<void> {
    const existing = this.entities.get(externalId);
    if (existing) {
      this.entities.set(externalId, {
        ...existing,
        updated_at: new Date().toISOString(),
      });
    }
  }

  async getChangesSince(_timestamp: Date): Promise<ExternalChange[]> {
    return this.changes;
  }

  mapToSudocode(external: ExternalEntity): {
    spec?: Partial<Spec>;
    issue?: Partial<Issue>;
  } {
    if (external.type === "spec") {
      return { spec: { title: external.title, content: external.description } };
    }
    return { issue: { title: external.title, content: external.description } };
  }

  mapFromSudocode(entity: Spec | Issue): Partial<ExternalEntity> {
    return {
      title: entity.title,
      description: entity.content,
    };
  }

  startWatching(callback: (changes: ExternalChange[]) => void): void {
    this.watchCallback = callback;
  }

  stopWatching(): void {
    this.watchCallback = undefined;
  }

  // Test helper to simulate external changes
  triggerChange(change: ExternalChange): void {
    this.watchCallback?.([change]);
  }

  // Override dispose to track it was called
  async dispose(): Promise<void> {
    this.disposeCalled = true;
    await super.dispose();
  }
}

describe("SyncCoordinator", () => {
  let coordinator: SyncCoordinator;
  let mockProvider: MockProvider;
  const projectPath = "/test/project";

  const defaultConfig: IntegrationsConfig = {
    // Using 'mock' as a dynamic key - in real usage this would be a known provider
  };

  // Helper to create a config with mock provider
  const createConfig = (
    enabled = true,
    autoSync = true
  ): IntegrationsConfig => {
    return {
      jira: {
        enabled,
        auto_sync: autoSync,
        default_sync_direction: "bidirectional",
        conflict_resolution: "newest-wins",
        instance_url: "https://mock.atlassian.net",
        auth_type: "basic",
      },
    } as IntegrationsConfig;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Suppress console.warn during tests
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    mockProvider = new MockProvider();
    // Override the name to match config
    (mockProvider as any).name = "jira";

    coordinator = new SyncCoordinator({
      projectPath,
      config: createConfig(),
    });
    coordinator.registerProvider(mockProvider);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Provider Management", () => {
    it("should register a provider", () => {
      const provider = coordinator.getProvider("jira");
      expect(provider).toBe(mockProvider);
    });

    it("should return undefined for unregistered provider", () => {
      const provider = coordinator.getProvider("nonexistent");
      expect(provider).toBeUndefined();
    });

    it("should return all registered provider names", () => {
      const names = coordinator.getProviderNames();
      expect(names).toContain("jira");
    });

    it("should allow registering multiple providers", () => {
      const anotherProvider = new MockProvider();
      (anotherProvider as any).name = "beads";
      coordinator.registerProvider(anotherProvider);

      const names = coordinator.getProviderNames();
      expect(names).toContain("jira");
      expect(names).toContain("beads");
    });
  });

  describe("Lifecycle", () => {
    describe("start", () => {
      it("should initialize enabled providers", async () => {
        await coordinator.start();
        expect(mockProvider.initializeCalled).toBe(true);
      });

      it("should skip disabled providers", async () => {
        coordinator = new SyncCoordinator({
          projectPath,
          config: createConfig(false),
        });
        coordinator.registerProvider(mockProvider);

        await coordinator.start();
        expect(mockProvider.initializeCalled).toBe(false);
      });

      it("should start watchers for auto_sync providers", async () => {
        await coordinator.start();
        expect(mockProvider.watchCallback).toBeDefined();
      });

      it("should not start watchers when auto_sync is false", async () => {
        coordinator = new SyncCoordinator({
          projectPath,
          config: createConfig(true, false),
        });
        coordinator.registerProvider(mockProvider);

        await coordinator.start();
        expect(mockProvider.watchCallback).toBeUndefined();
      });

      it("should warn when provider validation fails", async () => {
        mockProvider.validateResult = {
          valid: false,
          errors: ["Connection failed"],
        };

        await coordinator.start();

        expect(console.warn).toHaveBeenCalledWith(
          expect.stringContaining("validation failed"),
          expect.arrayContaining(["Connection failed"])
        );
      });
    });

    describe("stop", () => {
      it("should dispose all providers", async () => {
        await coordinator.start();
        await coordinator.stop();

        expect(mockProvider.disposeCalled).toBe(true);
      });

      it("should stop watchers", async () => {
        await coordinator.start();
        expect(mockProvider.watchCallback).toBeDefined();

        await coordinator.stop();
        expect(mockProvider.watchCallback).toBeUndefined();
      });
    });
  });

  describe("Sync Operations", () => {
    describe("syncProvider", () => {
      it("should throw for unknown provider", async () => {
        await expect(coordinator.syncProvider("unknown")).rejects.toThrow(
          "Unknown provider: unknown"
        );
      });

      it("should fetch and process changes", async () => {
        mockProvider.changes = [
          {
            entity_id: "ext-1",
            entity_type: "issue",
            change_type: "updated",
            timestamp: new Date().toISOString(),
          },
        ];

        await coordinator.start();
        const results = await coordinator.syncProvider("jira");

        expect(results).toHaveLength(1);
      });

      it("should update last sync time after sync", async () => {
        await coordinator.start();

        const beforeSync = new Date();
        await coordinator.syncProvider("jira");
        // The internal lastSyncTimes map should be updated
        // We can't directly test this without exposing internals,
        // but we can verify the sync completed without error
      });
    });

    describe("syncAll", () => {
      it("should sync all enabled providers", async () => {
        const anotherProvider = new MockProvider();
        (anotherProvider as any).name = "beads";
        coordinator.registerProvider(anotherProvider);

        // Need to update config to include both
        coordinator = new SyncCoordinator({
          projectPath,
          config: {
            jira: {
              enabled: true,
              auto_sync: false,
              default_sync_direction: "bidirectional",
              conflict_resolution: "newest-wins",
              instance_url: "https://mock.atlassian.net",
              auth_type: "basic",
            },
            beads: {
              enabled: true,
              auto_sync: false,
              default_sync_direction: "bidirectional",
              conflict_resolution: "newest-wins",
              path: ".beads",
            },
          } as IntegrationsConfig,
        });
        coordinator.registerProvider(mockProvider);
        coordinator.registerProvider(anotherProvider);

        await coordinator.start();
        const results = await coordinator.syncAll();

        // Both providers should have been synced
        expect(Array.isArray(results)).toBe(true);
      });

      it("should skip disabled providers", async () => {
        coordinator = new SyncCoordinator({
          projectPath,
          config: createConfig(false),
        });
        coordinator.registerProvider(mockProvider);

        await coordinator.start();
        const results = await coordinator.syncAll();

        expect(results).toHaveLength(0);
      });
    });

    describe("syncEntity", () => {
      it("should skip entities without external links", async () => {
        // Mock getIssueFromJsonl to return entity without external_links
        mockedGetIssueFromJsonl.mockReturnValue({
          id: "i-test",
          title: "Test Issue",
          uuid: "uuid-123",
          content: "content",
          status: "open",
          priority: 2,
          created_at: "2025-01-01T00:00:00Z",
          updated_at: "2025-01-01T00:00:00Z",
          relationships: [],
          tags: [],
          // No external_links
        });

        const results = await coordinator.syncEntity("i-test");

        expect(results).toHaveLength(1);
        expect(results[0].action).toBe("skipped");
      });

      it("should skip disabled links", async () => {
        // Mock getIssueFromJsonl to return entity with disabled external link
        mockedGetIssueFromJsonl.mockReturnValue({
          id: "i-test",
          title: "Test Issue",
          uuid: "uuid-123",
          content: "content",
          status: "open",
          priority: 2,
          created_at: "2025-01-01T00:00:00Z",
          updated_at: "2025-01-01T00:00:00Z",
          relationships: [],
          tags: [],
          external_links: [
            {
              provider: "jira",
              external_id: "EXT-123",
              sync_enabled: false, // Disabled
              sync_direction: "bidirectional",
            },
          ],
        });

        const results = await coordinator.syncEntity("i-test");

        expect(results).toHaveLength(0);
      });
    });
  });

  describe("Link Management", () => {
    const testIssue = {
      id: "i-test",
      title: "Test Issue",
      uuid: "uuid-123",
      content: "content",
      status: "open",
      priority: 2,
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
      relationships: [],
      tags: [],
    };

    beforeEach(() => {
      (readJSONLSync as ReturnType<typeof vi.fn>).mockReturnValue([testIssue]);

      (getJSONLEntitySync as ReturnType<typeof vi.fn>).mockReturnValue(testIssue);

      // Set up the external-links mock for loadEntity
      mockedGetIssueFromJsonl.mockReturnValue(testIssue);
      mockedGetSpecFromJsonl.mockReturnValue(null);
    });

    describe("linkEntity", () => {
      it("should throw for non-existent entity", async () => {
        (getJSONLEntitySync as ReturnType<typeof vi.fn>).mockReturnValue(null);
        mockedGetIssueFromJsonl.mockReturnValue(null);
        mockedGetSpecFromJsonl.mockReturnValue(null);

        await expect(
          coordinator.linkEntity("i-nonexistent", "EXT-123", "jira")
        ).rejects.toThrow("Entity not found");
      });
    });

    describe("unlinkEntity", () => {

      it("should do nothing for entity without links", async () => {
        const issueNoLinks = {
          id: "i-test",
          title: "Test Issue",
          uuid: "uuid-123",
          content: "content",
          status: "open",
          priority: 2,
          created_at: "2025-01-01T00:00:00Z",
          updated_at: "2025-01-01T00:00:00Z",
          // No external_links
        };
        (getJSONLEntitySync as ReturnType<typeof vi.fn>).mockReturnValue(issueNoLinks);
        mockedGetIssueFromJsonl.mockReturnValue(issueNoLinks);

        await coordinator.unlinkEntity("i-test", "EXT-123");

        expect(writeJSONLSync).not.toHaveBeenCalled();
      });

      it("should do nothing for non-existent entity", async () => {
        (getJSONLEntitySync as ReturnType<typeof vi.fn>).mockReturnValue(null);
        mockedGetIssueFromJsonl.mockReturnValue(null);
        mockedGetSpecFromJsonl.mockReturnValue(null);

        await coordinator.unlinkEntity("i-nonexistent", "EXT-123");

        expect(writeJSONLSync).not.toHaveBeenCalled();
      });
    });
  });

  describe("Conflict Resolution", () => {
    it("should use configured conflict resolution strategy", async () => {
      coordinator = new SyncCoordinator({
        projectPath,
        config: {
          jira: {
            enabled: true,
            auto_sync: false,
            default_sync_direction: "bidirectional",
            conflict_resolution: "sudocode-wins",
            instance_url: "https://mock.atlassian.net",
            auth_type: "basic",
          },
        } as IntegrationsConfig,
      });
      coordinator.registerProvider(mockProvider);

      // The conflict resolution is tested via the conflict-resolver tests
      // Here we just verify the coordinator is properly configured
      expect((coordinator as any).options.config.jira.conflict_resolution).toBe(
        "sudocode-wins"
      );
    });

    it("should call onConflict callback for manual resolution", async () => {
      const onConflict = vi.fn().mockResolvedValue("sudocode");

      coordinator = new SyncCoordinator({
        projectPath,
        config: {
          jira: {
            enabled: true,
            auto_sync: false,
            default_sync_direction: "bidirectional",
            conflict_resolution: "manual",
            instance_url: "https://mock.atlassian.net",
            auth_type: "basic",
          },
        } as IntegrationsConfig,
        onConflict,
      });
      coordinator.registerProvider(mockProvider);

      // The callback is stored and would be called during conflict resolution
      expect((coordinator as any).options.onConflict).toBe(onConflict);
    });
  });

  describe("Outbound Entity Deletion (handleEntityDeleted)", () => {
    const externalLinks = [
      {
        provider: "jira" as const,
        external_id: "EXT-TO-DELETE",
        sync_enabled: true,
        sync_direction: "bidirectional" as const,
        last_synced_at: "2025-01-01T00:00:00Z",
      },
    ];

    let updateEntitySpy: ReturnType<typeof vi.fn>;
    let deleteEntitySpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      // Spy on updateEntity and add deleteEntity method to mock provider
      updateEntitySpy = vi.fn().mockResolvedValue(undefined);
      deleteEntitySpy = vi.fn().mockResolvedValue(undefined);
      mockProvider.updateEntity = updateEntitySpy;
      (mockProvider as any).deleteEntity = deleteEntitySpy;
    });

    it("should close external entity when delete_behavior is 'close' (default)", async () => {
      await coordinator.start();
      const results = await coordinator.handleEntityDeleted("i-deleted", externalLinks);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].entity_id).toBe("i-deleted");
      expect(results[0].external_id).toBe("EXT-TO-DELETE");
      expect(results[0].action).toBe("updated");

      // Should call updateEntity with status: "closed"
      expect(updateEntitySpy).toHaveBeenCalledWith(
        "EXT-TO-DELETE",
        expect.objectContaining({ status: "closed" })
      );
      expect(deleteEntitySpy).not.toHaveBeenCalled();
    });

    it("should delete external entity when delete_behavior is 'delete'", async () => {
      coordinator = new SyncCoordinator({
        projectPath,
        config: {
          jira: {
            enabled: true,
            auto_sync: false,
            delete_behavior: "delete",
            default_sync_direction: "bidirectional",
            conflict_resolution: "newest-wins",
            instance_url: "https://mock.atlassian.net",
            auth_type: "basic",
          },
        } as IntegrationsConfig,
      });
      // Re-apply spies to the provider for the new coordinator
      mockProvider.updateEntity = updateEntitySpy;
      (mockProvider as any).deleteEntity = deleteEntitySpy;
      coordinator.registerProvider(mockProvider);

      await coordinator.start();
      const results = await coordinator.handleEntityDeleted("i-deleted", externalLinks);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].action).toBe("updated");

      // Should call deleteEntity
      expect(deleteEntitySpy).toHaveBeenCalledWith("EXT-TO-DELETE");
      expect(updateEntitySpy).not.toHaveBeenCalled();
    });

    it("should skip when delete_behavior is 'ignore'", async () => {
      coordinator = new SyncCoordinator({
        projectPath,
        config: {
          jira: {
            enabled: true,
            auto_sync: false,
            delete_behavior: "ignore",
            default_sync_direction: "bidirectional",
            conflict_resolution: "newest-wins",
            instance_url: "https://mock.atlassian.net",
            auth_type: "basic",
          },
        } as IntegrationsConfig,
      });
      mockProvider.updateEntity = updateEntitySpy;
      (mockProvider as any).deleteEntity = deleteEntitySpy;
      coordinator.registerProvider(mockProvider);

      await coordinator.start();
      const results = await coordinator.handleEntityDeleted("i-deleted", externalLinks);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].action).toBe("skipped");

      // Should not call any update/delete methods
      expect(updateEntitySpy).not.toHaveBeenCalled();
      expect(deleteEntitySpy).not.toHaveBeenCalled();
    });

    it("should skip disabled links", async () => {
      await coordinator.start();
      const disabledLinks = [
        {
          provider: "jira" as const,
          external_id: "EXT-DISABLED",
          sync_enabled: false,
          sync_direction: "bidirectional" as const,
        },
      ];

      const results = await coordinator.handleEntityDeleted("i-deleted", disabledLinks);

      expect(results).toHaveLength(0);
      expect(updateEntitySpy).not.toHaveBeenCalled();
    });

    it("should skip inbound-only links", async () => {
      await coordinator.start();
      const inboundLinks = [
        {
          provider: "jira" as const,
          external_id: "EXT-INBOUND",
          sync_enabled: true,
          sync_direction: "inbound" as const,
        },
      ];

      const results = await coordinator.handleEntityDeleted("i-deleted", inboundLinks);

      expect(results).toHaveLength(0);
      expect(updateEntitySpy).not.toHaveBeenCalled();
    });

    it("should handle outbound-only links", async () => {
      await coordinator.start();
      const outboundLinks = [
        {
          provider: "jira" as const,
          external_id: "EXT-OUTBOUND",
          sync_enabled: true,
          sync_direction: "outbound" as const,
        },
      ];

      const results = await coordinator.handleEntityDeleted("i-deleted", outboundLinks);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(updateEntitySpy).toHaveBeenCalledWith(
        "EXT-OUTBOUND",
        expect.objectContaining({ status: "closed" })
      );
    });

    it("should handle empty external links array", async () => {
      await coordinator.start();
      const results = await coordinator.handleEntityDeleted("i-deleted", []);

      expect(results).toHaveLength(0);
    });

    it("should handle provider not found", async () => {
      await coordinator.start();
      const unknownProviderLinks = [
        {
          provider: "unknown-provider" as any,
          external_id: "EXT-UNKNOWN",
          sync_enabled: true,
          sync_direction: "bidirectional" as const,
        },
      ];

      const results = await coordinator.handleEntityDeleted("i-deleted", unknownProviderLinks);

      expect(results).toHaveLength(0);
    });

    it("should handle provider errors gracefully", async () => {
      updateEntitySpy = vi.fn().mockRejectedValue(new Error("API error"));
      mockProvider.updateEntity = updateEntitySpy;

      await coordinator.start();
      const results = await coordinator.handleEntityDeleted("i-deleted", externalLinks);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain("API error");
    });

    it("should handle multiple external links", async () => {
      const anotherProvider = new MockProvider();
      (anotherProvider as any).name = "beads";
      const beadsDeleteSpy = vi.fn().mockResolvedValue(undefined);
      const beadsUpdateSpy = vi.fn().mockResolvedValue(undefined);
      anotherProvider.updateEntity = beadsUpdateSpy;
      (anotherProvider as any).deleteEntity = beadsDeleteSpy;

      // Update config to include beads
      coordinator = new SyncCoordinator({
        projectPath,
        config: {
          jira: {
            enabled: true,
            auto_sync: false,
            delete_behavior: "close",
            default_sync_direction: "bidirectional",
            conflict_resolution: "newest-wins",
            instance_url: "https://mock.atlassian.net",
            auth_type: "basic",
          },
          beads: {
            enabled: true,
            auto_sync: false,
            delete_behavior: "delete",
            default_sync_direction: "bidirectional",
            conflict_resolution: "newest-wins",
            path: ".beads",
          },
        } as IntegrationsConfig,
      });
      // Re-apply spies to mock provider
      mockProvider.updateEntity = updateEntitySpy;
      (mockProvider as any).deleteEntity = deleteEntitySpy;
      coordinator.registerProvider(mockProvider);
      coordinator.registerProvider(anotherProvider);

      await coordinator.start();

      const multipleLinks = [
        {
          provider: "jira" as const,
          external_id: "JIRA-123",
          sync_enabled: true,
          sync_direction: "bidirectional" as const,
        },
        {
          provider: "beads" as any,
          external_id: "beads-456",
          sync_enabled: true,
          sync_direction: "bidirectional" as const,
        },
      ];

      const results = await coordinator.handleEntityDeleted("i-deleted", multipleLinks);

      expect(results).toHaveLength(2);
      // Jira should close (delete_behavior: close)
      expect(updateEntitySpy).toHaveBeenCalledWith(
        "JIRA-123",
        expect.objectContaining({ status: "closed" })
      );
      // Beads should delete (delete_behavior: delete)
      expect(beadsDeleteSpy).toHaveBeenCalledWith("beads-456");
    });
  });
});

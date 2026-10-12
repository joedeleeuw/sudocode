/**
 * Integration tests for import API flow
 *
 * Tests the complete import workflow from URL to spec creation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import { createImportRouter } from "../../src/routes/import.js";
import * as fs from "fs";
import * as path from "path";
import { tmpdir } from "os";

// Mock fs module
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof fs>("fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

// Track mock state
let mockConfigData: Record<string, unknown> = {};
let mockSpecsData: string[] = [];
let mockIssuesData: string[] = [];

// Mock provider
const mockProvider = {
  name: "github",
  supportsWatch: false,
  supportsPolling: false,
  supportsOnDemandImport: true,
  supportsSearch: true,
  supportsPush: false,
  initialize: vi.fn().mockResolvedValue(undefined),
  dispose: vi.fn().mockResolvedValue(undefined),
  canHandleUrl: vi.fn((url: string) => url.includes("github.com")),
  parseUrl: vi.fn(),
  fetchByUrl: vi.fn(),
  fetchComments: vi.fn().mockResolvedValue([]),
  fetchEntity: vi.fn(),
  searchEntities: vi.fn(),
  createEntity: vi.fn(),
  updateEntity: vi.fn(),
  getChangesSince: vi.fn(),
  mapToSudocode: vi.fn(),
  mapFromSudocode: vi.fn(),
};

// Mock the plugin loader
vi.mock("@sudocode-ai/cli/dist/integrations/index.js", () => ({
  getFirstPartyPlugins: vi.fn(() => [
    { name: "github", package: "@sudocode-ai/integration-github" },
  ]),
  loadPlugin: vi.fn(async (name: string) => {
    if (name === "github") {
      return {
        name: "github",
        displayName: "GitHub",
        version: "0.1.0",
        description: "GitHub integration plugin",
        validateConfig: () => ({ valid: true, errors: [], warnings: [] }),
        testConnection: async () => ({
          success: true,
          configured: true,
          enabled: true,
        }),
        createProvider: () => mockProvider,
      };
    }
    return null;
  }),
  testProviderConnection: vi.fn(async () => ({
    success: true,
    configured: true,
    enabled: true,
  })),
}));

// Mock JSONL operations
vi.mock("@sudocode-ai/cli/dist/operations/external-links.js", () => ({
  findSpecsByExternalLink: vi.fn(() => []),
  findIssuesByExternalLink: vi.fn(() => []),
  createSpecFromExternal: vi.fn((sudocodeDir: string, input: any) => ({
    id: "s-import1",
    uuid: "import-uuid-123",
    title: input.title,
    content: input.content || "",
    file_path: `specs/s-import1.md`,
    priority: input.priority || 2,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    external_links: [
      {
        provider: input.external.provider,
        external_id: input.external.external_id,
        sync_enabled: true,
        sync_direction: input.external.sync_direction,
      },
    ],
    relationships: [],
    tags: [],
  })),
}));

// Mock issue operations for comment import
vi.mock("@sudocode-ai/cli/dist/operations/issues.js", () => ({
  createIssue: vi.fn((_db: any, input: any) => ({
    id: input.id || "i-placeholder",
    uuid: input.uuid || "placeholder-uuid",
    title: input.title,
    content: input.content || "",
    status: input.status || "open",
    priority: input.priority || 2,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    relationships: [],
    tags: [],
  })),
}));

// Mock feedback operations for comment import
vi.mock("@sudocode-ai/cli/dist/operations/feedback.js", () => ({
  createFeedback: vi.fn((_db: any, input: any) => ({
    id: `fb-${Date.now()}`,
    uuid: `fb-uuid-${Date.now()}`,
    from_id: input.from_id,
    to_id: input.to_id,
    feedback_type: input.feedback_type,
    content: input.content,
    agent: input.agent,
    created_at: input.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })),
}));

// Mock ID generator for comment import
vi.mock("@sudocode-ai/cli/dist/id-generator.js", () => ({
  generateIssueId: vi.fn(() => ({
    id: "i-placeholder",
    uuid: "placeholder-uuid-123",
  })),
}));

// Mock export service
vi.mock("../../src/services/export.js", () => ({
  triggerExport: vi.fn(),
  syncEntityToMarkdown: vi.fn().mockResolvedValue(undefined),
}));

// Mock websocket service
vi.mock("../../src/services/websocket.js", () => ({
  broadcastSpecUpdate: vi.fn(),
}));


describe("Import Flow Integration", () => {
  let app: express.Application;
  let testProjectDir: string;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create test app
    app = express();
    app.use(express.json());

    // Mock project middleware
    app.use((req, _res, next) => {
      testProjectDir = path.join(tmpdir(), "test-sudocode");
      (req as any).project = {
        id: "test-project",
        path: testProjectDir,
        sudocodeDir: path.join(testProjectDir, ".sudocode"),
        db: {},
      };
      next();
    });

    app.use("/api/import", createImportRouter());

    // Setup fs mocks
    vi.mocked(fs.existsSync).mockImplementation((p: string | Buffer | URL) => {
      const pathStr = p.toString();
      if (pathStr.includes("config.json")) return true;
      if (pathStr.includes("specs.jsonl")) return true;
      if (pathStr.includes("issues.jsonl")) return true;
      return false;
    });

    vi.mocked(fs.readFileSync).mockImplementation((p: string | Buffer | URL) => {
      const pathStr = p.toString();
      if (pathStr.includes("config.json")) {
        return JSON.stringify(mockConfigData);
      }
      if (pathStr.includes("specs.jsonl")) {
        return mockSpecsData.join("\n");
      }
      if (pathStr.includes("issues.jsonl")) {
        return mockIssuesData.join("\n");
      }
      return "";
    });

    // Reset mock data
    mockConfigData = {};
    mockSpecsData = [];
    mockIssuesData = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("GET /api/import/providers", () => {
    it("should return list of providers supporting on-demand import", async () => {
      const response = await request(app)
        .get("/api/import/providers")
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.providers).toHaveLength(1);
      expect(response.body.data.providers[0]).toMatchObject({
        name: "github",
        displayName: "GitHub",
        supportsOnDemandImport: true,
        configured: true,
        authMethod: "gh-cli",
      });
    });
  });

  describe("POST /api/import/preview", () => {
    it("should return preview for valid GitHub URL", async () => {
      const mockEntity = {
        id: "octocat/hello-world#42",
        type: "issue" as const,
        title: "Found a bug",
        description: "Something is broken",
        status: "open",
        url: "https://github.com/octocat/hello-world/issues/42",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-15T00:00:00Z",
      };

      mockProvider.canHandleUrl.mockReturnValue(true);
      mockProvider.fetchByUrl.mockResolvedValue(mockEntity);
      mockProvider.fetchComments.mockResolvedValue([
        { id: "c1", author: "user", body: "test", created_at: "2024-01-01" },
      ]);

      const response = await request(app)
        .post("/api/import/preview")
        .send({ url: "https://github.com/octocat/hello-world/issues/42" })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.provider).toBe("github");
      expect(response.body.data.entity.title).toBe("Found a bug");
      expect(response.body.data.commentsCount).toBe(1);
      expect(response.body.data.alreadyLinked).toBeUndefined();
    });

    it("should indicate if entity is already imported", async () => {
      const mockEntity = {
        id: "octocat/hello-world#42",
        type: "issue" as const,
        title: "Found a bug",
        description: "Something is broken",
      };

      mockProvider.canHandleUrl.mockReturnValue(true);
      mockProvider.fetchByUrl.mockResolvedValue(mockEntity);

      // Mock already imported
      const { findSpecsByExternalLink } = await import(
        "@sudocode-ai/cli/dist/operations/external-links.js"
      );
      vi.mocked(findSpecsByExternalLink).mockReturnValueOnce([
        {
          id: "s-existing",
          uuid: "uuid-existing",
          title: "Found a bug",
          file_path: "specs/s-existing.md",
          content: "",
          priority: 2,
          created_at: "2024-01-01",
          updated_at: "2024-01-01",
          external_links: [
            {
              provider: "github",
              external_id: "octocat/hello-world#42",
              sync_enabled: true,
              sync_direction: "inbound",
              last_synced_at: "2024-01-10T00:00:00Z",
            },
          ],
          relationships: [],
          tags: [],
        },
      ]);

      const response = await request(app)
        .post("/api/import/preview")
        .send({ url: "https://github.com/octocat/hello-world/issues/42" })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.alreadyLinked).toMatchObject({
        entityId: "s-existing",
        entityType: "spec",
        lastSyncedAt: "2024-01-10T00:00:00Z",
      });
    });

    it("should return 400 for missing URL", async () => {
      const response = await request(app)
        .post("/api/import/preview")
        .send({})
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("URL is required");
    });

    it("should return 422 for unsupported URL", async () => {
      mockProvider.canHandleUrl.mockReturnValue(false);

      const response = await request(app)
        .post("/api/import/preview")
        .send({ url: "https://unsupported.com/issue/1" })
        .expect(422);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("No provider found");
    });

    it("should return 404 when entity not found", async () => {
      mockProvider.canHandleUrl.mockReturnValue(true);
      mockProvider.fetchByUrl.mockResolvedValue(null);

      const response = await request(app)
        .post("/api/import/preview")
        .send({ url: "https://github.com/octocat/hello-world/issues/99999" })
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Entity not found");
    });
  });

  describe("POST /api/import", () => {

    it("should return 409 for duplicate import", async () => {
      const mockEntity = {
        id: "octocat/hello-world#42",
        type: "issue" as const,
        title: "Found a bug",
        description: "Something is broken",
      };

      mockProvider.canHandleUrl.mockReturnValue(true);
      mockProvider.fetchByUrl.mockResolvedValue(mockEntity);

      const { findSpecsByExternalLink } = await import(
        "@sudocode-ai/cli/dist/operations/external-links.js"
      );
      vi.mocked(findSpecsByExternalLink).mockReturnValueOnce([
        {
          id: "s-existing",
          uuid: "uuid-existing",
          title: "Found a bug",
          file_path: "specs/s-existing.md",
          content: "",
          priority: 2,
          created_at: "2024-01-01",
          updated_at: "2024-01-01",
          external_links: [],
          relationships: [],
          tags: [],
        },
      ]);

      const response = await request(app)
        .post("/api/import")
        .send({ url: "https://github.com/octocat/hello-world/issues/42" })
        .expect(409);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Already imported");
      expect(response.body.data.entityId).toBe("s-existing");
    });

  });
});

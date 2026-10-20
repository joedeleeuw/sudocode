/**
 * Unit tests for sync command handlers and auto-sync direction detection
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initDatabase } from "../../../src/db.js";
import {
  handleSync,
  handleExport,
  handleImport,
} from "../../../src/cli/sync-commands.js";
import { createSpec } from "../../../src/operations/specs.js";
import { createIssue } from "../../../src/operations/issues.js";
import { exportToJSONL } from "../../../src/export.js";
import type Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Helper to ensure timestamps are different between operations
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper to manually set database timestamps (for testing sync direction logic)
function setDatabaseTimestamp(
  db: Database.Database,
  entityType: "spec" | "issue",
  entityId: string,
  timestamp: Date
) {
  const table = entityType === "spec" ? "specs" : "issues";
  const isoTimestamp = timestamp.toISOString();
  db.prepare(`UPDATE ${table} SET updated_at = ? WHERE id = ?`).run(
    isoTimestamp,
    entityId
  );
}

describe("Sync Commands", () => {
  let db: Database.Database;
  let tempDir: string;
  let specsDir: string;
  let issuesDir: string;
  let specsJsonl: string;
  let issuesJsonl: string;
  let consoleLogSpy: any;
  let consoleErrorSpy: any;

  beforeEach(() => {
    // Create a fresh in-memory database for each test
    db = initDatabase({ path: ":memory:" });

    // Create temporary directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sudocode-sync-test-"));
    specsDir = path.join(tempDir, "specs");
    issuesDir = path.join(tempDir, "issues");
    specsJsonl = path.join(tempDir, "specs.jsonl");
    issuesJsonl = path.join(tempDir, "issues.jsonl");

    // Create directories
    fs.mkdirSync(specsDir, { recursive: true });
    fs.mkdirSync(issuesDir, { recursive: true });

    // Create config.json to mark directory as initialized (prevents auto-init during tests)
    const config = {
      version: "0.1.0",
      id_prefix: { spec: "SPEC", issue: "ISSUE" },
    };
    fs.writeFileSync(
      path.join(tempDir, "config.json"),
      JSON.stringify(config, null, 2),
      "utf8"
    );

    // Create cache.db file
    const dbPath = path.join(tempDir, "cache.db");
    fs.writeFileSync(dbPath, "");

    // Spy on console methods
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore spies
    consoleLogSpy?.mockRestore();
    consoleErrorSpy?.mockRestore();

    // Close database
    if (db) {
      db.close();
    }

    // Clean up temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("Content stability across syncs", () => {
    it("should set JSONL file mtime to match content timestamps", async () => {
      // This test verifies that JSONL files get their mtime set to match
      // the newest updated_at timestamp in their contents, which improves
      // sync direction detection accuracy.

      createSpec(db, {
        id: "SPEC-001",
        title: "Test Spec",
        file_path: "specs/test.md",
        content: "# Content",
        priority: 2,
      });

      const { getSpec } = await import("../../../src/operations/specs.js");
      const spec = getSpec(db, "SPEC-001");

      // Parse timestamp with same logic as jsonl.ts (SQLite returns UTC without 'Z')
      const timestamp = String(spec!.updated_at);
      const hasZone =
        timestamp.endsWith("Z") ||
        timestamp.includes("+") ||
        /[+-]\d{2}:\d{2}$/.test(timestamp);
      const utcTimestamp = hasZone
        ? timestamp
        : timestamp.replace(" ", "T") + "Z";
      const specUpdatedAt = new Date(utcTimestamp).getTime();

      // Export to JSONL
      await exportToJSONL(db, { outputDir: tempDir });

      // Check that JSONL file mtime matches the spec's updated_at
      const jsonlPath = path.join(tempDir, "specs.jsonl");
      const jsonlStat = fs.statSync(jsonlPath);
      const jsonlMtime = jsonlStat.mtimeMs;

      // Allow 1 second tolerance for filesystem precision
      const timeDiff = Math.abs(jsonlMtime - specUpdatedAt);
      expect(timeDiff).toBeLessThan(1000);
    });

  });

  describe("Manual sync overrides", () => {
    it("should respect --from-markdown flag regardless of timestamps", async () => {
      // Create newer JSONL
      createSpec(db, {
        id: "SPEC-001",
        title: "DB Spec",
        file_path: "specs/test.md",
        content: "# DB content",
        priority: 2,
      });

      await exportToJSONL(db, { outputDir: tempDir });

      // Create older markdown
      const mdPath = path.join(specsDir, "test.md");
      fs.writeFileSync(
        mdPath,
        "---\nid: SPEC-001\ntitle: Markdown Spec\nfile_path: specs/test.md\n---\n\n# Markdown content",
        "utf8"
      );

      const oldTime = new Date(Date.now() - 10000);
      fs.utimesSync(mdPath, oldTime, oldTime);

      const ctx = { db, outputDir: tempDir, jsonOutput: false };

      // Force from-markdown
      await handleSync(ctx, { fromMarkdown: true });

      const output = consoleLogSpy.mock.calls.flat().join(" ");
      expect(output).toContain("Syncing from markdown to database");

      // Verify markdown content was synced
      const { getSpec } = await import("../../../src/operations/specs.js");
      const spec = getSpec(db, "SPEC-001");
      expect(spec?.title).toBe("Markdown Spec");
      expect(spec?.content).toContain("# Markdown content");
    });

    it("should respect --to-markdown flag regardless of timestamps", async () => {
      // Create older JSONL
      createSpec(db, {
        id: "SPEC-001",
        title: "DB Spec",
        file_path: "specs/test.md",
        content: "# DB content",
        priority: 2,
      });

      await exportToJSONL(db, { outputDir: tempDir });

      const oldTime = new Date(Date.now() - 10000);
      fs.utimesSync(specsJsonl, oldTime, oldTime);
      fs.utimesSync(issuesJsonl, oldTime, oldTime);

      // Create newer markdown
      const mdPath = path.join(specsDir, "test.md");
      fs.writeFileSync(
        mdPath,
        "---\nid: SPEC-001\ntitle: Markdown Spec\nfile_path: specs/test.md\n---\n\n# Markdown content",
        "utf8"
      );

      const ctx = { db, outputDir: tempDir, jsonOutput: false };

      // Force to-markdown
      await handleSync(ctx, { toMarkdown: true });

      const output = consoleLogSpy.mock.calls.flat().join(" ");
      expect(output).toContain("Syncing from database to markdown");

      // Verify database content was synced to markdown (both frontmatter AND body)
      const { parseMarkdownFile } = await import("../../../src/markdown.js");
      const parsed = parseMarkdownFile(mdPath, db, tempDir);
      expect(parsed.data.title).toBe("DB Spec");
      // syncJSONLToMarkdown now writes full content from database
      expect(parsed.content).toContain("# DB content");
    });
  });

});

describe("Export and Import Commands", () => {
  let db: Database.Database;
  let tempDir: string;
  let outputDir: string;
  let consoleLogSpy: any;
  let consoleErrorSpy: any;
  let processExitSpy: any;

  beforeEach(() => {
    db = initDatabase({ path: ":memory:" });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sudocode-export-test-"));
    outputDir = path.join(tempDir, "output");

    // Create output directory
    fs.mkdirSync(outputDir, { recursive: true });

    // Spy on console methods
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    processExitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    consoleLogSpy?.mockRestore();
    consoleErrorSpy?.mockRestore();
    processExitSpy?.mockRestore();

    if (db) {
      db.close();
    }

    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("handleExport", () => {
    it("should export database to JSONL files", async () => {
      const ctx = { db, outputDir: tempDir, jsonOutput: false };

      // Create test data
      createSpec(db, {
        id: "SPEC-001",
        title: "Test Spec",
        file_path: "specs/test.md",
        content: "# Content",
        priority: 2,
      });

      createIssue(db, {
        id: "ISSUE-001",
        title: "Test Issue",
        content: "# Issue content",
        status: "open",
        priority: 1,
      });

      await handleExport(ctx, { output: outputDir });

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("✓ Exported to JSONL")
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Output: ${outputDir}`)
      );

      // Verify JSONL files were created
      expect(fs.existsSync(path.join(outputDir, "specs.jsonl"))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "issues.jsonl"))).toBe(true);

      // Verify content
      const specsContent = fs.readFileSync(
        path.join(outputDir, "specs.jsonl"),
        "utf8"
      );
      expect(specsContent).toContain("SPEC-001");
      expect(specsContent).toContain("Test Spec");

      const issuesContent = fs.readFileSync(
        path.join(outputDir, "issues.jsonl"),
        "utf8"
      );
      expect(issuesContent).toContain("ISSUE-001");
      expect(issuesContent).toContain("Test Issue");
    });

    it("should output JSON when jsonOutput is true", async () => {
      const ctx = { db, outputDir: tempDir, jsonOutput: true };

      createSpec(db, {
        id: "SPEC-001",
        title: "Test",
        file_path: "specs/test.md",
        content: "# Test",
        priority: 2,
      });

      await handleExport(ctx, { output: outputDir });

      const output = consoleLogSpy.mock.calls[0][0];
      const parsed = JSON.parse(output);

      expect(parsed.success).toBe(true);
      expect(parsed.outputDir).toBe(outputDir);
    });

    it("should export to default directory when no output specified", async () => {
      const ctx = { db, outputDir: tempDir, jsonOutput: false };

      createSpec(db, {
        id: "SPEC-001",
        title: "Test",
        file_path: "specs/test.md",
        content: "# Test",
        priority: 2,
      });

      await handleExport(ctx, { output: tempDir });

      // Should create files in specified directory
      expect(fs.existsSync(path.join(tempDir, "specs.jsonl"))).toBe(true);
    });

    it("should handle export with no data", async () => {
      const ctx = { db, outputDir: tempDir, jsonOutput: false };

      await handleExport(ctx, { output: outputDir });

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("✓ Exported to JSONL")
      );

      // JSONL files should still be created (empty)
      expect(fs.existsSync(path.join(outputDir, "specs.jsonl"))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "issues.jsonl"))).toBe(true);
    });

    it("should create output directory if it doesn't exist", async () => {
      const ctx = { db, outputDir: tempDir, jsonOutput: false };
      const newOutputDir = path.join(tempDir, "new-output", "nested");

      createSpec(db, {
        id: "SPEC-001",
        title: "Test",
        file_path: "specs/test.md",
        content: "# Test",
        priority: 2,
      });

      await handleExport(ctx, { output: newOutputDir });

      expect(fs.existsSync(path.join(newOutputDir, "specs.jsonl"))).toBe(true);
    });

    it("should overwrite existing JSONL files", async () => {
      const ctx = { db, outputDir: tempDir, jsonOutput: false };

      // Create initial data and export
      createSpec(db, {
        id: "SPEC-001",
        title: "First Version",
        file_path: "specs/test.md",
        content: "# First",
        priority: 2,
      });

      await handleExport(ctx, { output: outputDir });

      // Update data and export again
      const { updateSpec } = await import("../../../src/operations/specs.js");
      updateSpec(db, "SPEC-001", { title: "Second Version" });

      consoleLogSpy.mockClear();

      await handleExport(ctx, { output: outputDir });

      // Verify updated content
      const specsContent = fs.readFileSync(
        path.join(outputDir, "specs.jsonl"),
        "utf8"
      );
      expect(specsContent).toContain("Second Version");
      expect(specsContent).not.toContain("First Version");
    });
  });

  describe("handleImport", () => {
    it("should import specs and issues from JSONL files", async () => {
      const ctx = { db, outputDir: tempDir, jsonOutput: false };
      const inputDir = path.join(tempDir, "input");
      fs.mkdirSync(inputDir, { recursive: true });

      // Create JSONL files
      const specData = {
        id: "SPEC-001",
        title: "Imported Spec",
        file_path: "specs/imported.md",
        content: "# Imported content",
        priority: 2,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const issueData = {
        id: "ISSUE-001",
        title: "Imported Issue",
        content: "# Issue content",
        status: "open",
        priority: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      fs.writeFileSync(
        path.join(inputDir, "specs.jsonl"),
        JSON.stringify(specData) + "\n",
        "utf8"
      );

      fs.writeFileSync(
        path.join(inputDir, "issues.jsonl"),
        JSON.stringify(issueData) + "\n",
        "utf8"
      );

      await handleImport(ctx, { input: inputDir });

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("✓ Imported from JSONL")
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Input: ${inputDir}`)
      );

      // Verify data was imported
      const { getSpec } = await import("../../../src/operations/specs.js");
      const { getIssue } = await import("../../../src/operations/issues.js");

      const spec = getSpec(db, "SPEC-001");
      expect(spec).toBeDefined();
      expect(spec?.title).toBe("Imported Spec");

      const issue = getIssue(db, "ISSUE-001");
      expect(issue).toBeDefined();
      expect(issue?.title).toBe("Imported Issue");
    });

    it("should output JSON when jsonOutput is true", async () => {
      const ctx = { db, outputDir: tempDir, jsonOutput: true };
      const inputDir = path.join(tempDir, "input");
      fs.mkdirSync(inputDir, { recursive: true });

      // Create minimal JSONL files
      fs.writeFileSync(path.join(inputDir, "specs.jsonl"), "", "utf8");
      fs.writeFileSync(path.join(inputDir, "issues.jsonl"), "", "utf8");
      fs.writeFileSync(path.join(inputDir, "relationships.jsonl"), "", "utf8");
      fs.writeFileSync(path.join(inputDir, "feedback.jsonl"), "", "utf8");

      await handleImport(ctx, { input: inputDir });

      const output = consoleLogSpy.mock.calls[0][0];
      const parsed = JSON.parse(output);

      expect(parsed.success).toBe(true);
      expect(parsed.inputDir).toBe(inputDir);
    });

    it("should handle import with empty JSONL files", async () => {
      const ctx = { db, outputDir: tempDir, jsonOutput: false };
      const inputDir = path.join(tempDir, "input");
      fs.mkdirSync(inputDir, { recursive: true });

      // Create empty JSONL files
      fs.writeFileSync(path.join(inputDir, "specs.jsonl"), "", "utf8");
      fs.writeFileSync(path.join(inputDir, "issues.jsonl"), "", "utf8");
      fs.writeFileSync(path.join(inputDir, "relationships.jsonl"), "", "utf8");
      fs.writeFileSync(path.join(inputDir, "feedback.jsonl"), "", "utf8");

      await handleImport(ctx, { input: inputDir });

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("✓ Imported from JSONL")
      );

      // Database should still be valid (no specs/issues)
      const { listSpecs } = await import("../../../src/operations/specs.js");
      const { listIssues } = await import("../../../src/operations/issues.js");

      expect(listSpecs(db, {}).length).toBe(0);
      expect(listIssues(db, {}).length).toBe(0);
    });

    it("should import relationships from JSONL", async () => {
      const ctx = { db, outputDir: tempDir, jsonOutput: false };
      const inputDir = path.join(tempDir, "input");
      fs.mkdirSync(inputDir, { recursive: true });

      // Create spec and issue data with relationships embedded
      const specData = {
        id: "SPEC-001",
        uuid: "uuid-spec-001",
        title: "Test Spec",
        file_path: "specs/test.md",
        content: "# Content",
        priority: 2,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        parent_id: null,
        relationships: [],
        tags: [],
      };

      const issueData = {
        id: "ISSUE-001",
        uuid: "uuid-issue-001",
        title: "Test Issue",
        content: "# Content",
        status: "open",
        priority: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        parent_id: null,
        assignee: null,
        closed_at: null,
        relationships: [
          {
            from: "ISSUE-001",
            from_type: "issue",
            to: "SPEC-001",
            to_type: "spec",
            type: "implements",
          },
        ],
        tags: [],
      };

      fs.writeFileSync(
        path.join(inputDir, "specs.jsonl"),
        JSON.stringify(specData) + "\n",
        "utf8"
      );

      fs.writeFileSync(
        path.join(inputDir, "issues.jsonl"),
        JSON.stringify(issueData) + "\n",
        "utf8"
      );

      await handleImport(ctx, { input: inputDir });

      // Verify relationship was imported
      const { getOutgoingRelationships } = await import(
        "../../../src/operations/relationships.js"
      );
      const relationships = getOutgoingRelationships(db, "ISSUE-001", "issue");

      expect(relationships).toHaveLength(1);
      expect(relationships[0].to_id).toBe("SPEC-001");
      expect(relationships[0].relationship_type).toBe("implements");
    });

    it("should handle missing JSONL files gracefully", async () => {
      const ctx = { db, outputDir: tempDir, jsonOutput: false };
      const inputDir = path.join(tempDir, "input");
      fs.mkdirSync(inputDir, { recursive: true });

      // Don't create any JSONL files

      await handleImport(ctx, { input: inputDir });

      // Should not crash, though it may log warnings
      // Database should be empty
      const { listSpecs } = await import("../../../src/operations/specs.js");
      expect(listSpecs(db, {}).length).toBe(0);
    });

    it("should perform round-trip export and import correctly", async () => {
      const ctx = { db, outputDir: tempDir, jsonOutput: false };
      const exportDir = path.join(tempDir, "export");

      // Create test data
      createSpec(db, {
        id: "SPEC-001",
        title: "Round Trip Spec",
        file_path: "specs/roundtrip.md",
        content: "# Round trip content",
        priority: 3,
      });

      createIssue(db, {
        id: "ISSUE-001",
        title: "Round Trip Issue",
        content: "# Issue content",
        status: "in_progress",
        priority: 2,
      });

      // Add relationship
      const { addRelationship } = await import(
        "../../../src/operations/relationships.js"
      );
      addRelationship(db, {
        from_id: "ISSUE-001",
        from_type: "issue",
        to_id: "SPEC-001",
        to_type: "spec",
        relationship_type: "implements",
      });

      // Export
      await handleExport(ctx, { output: exportDir });

      // Create new database
      const db2 = initDatabase({ path: ":memory:" });
      const ctx2 = { db: db2, outputDir: tempDir, jsonOutput: false };

      consoleLogSpy.mockClear();

      // Import into new database
      await handleImport(ctx2, { input: exportDir });

      // Verify all data was imported correctly
      const { getSpec } = await import("../../../src/operations/specs.js");
      const { getIssue } = await import("../../../src/operations/issues.js");
      const { getOutgoingRelationships } = await import(
        "../../../src/operations/relationships.js"
      );

      const spec = getSpec(db2, "SPEC-001");
      expect(spec?.title).toBe("Round Trip Spec");
      expect(spec?.priority).toBe(3);

      const issue = getIssue(db2, "ISSUE-001");
      expect(issue?.title).toBe("Round Trip Issue");
      expect(issue?.status).toBe("in_progress");
      expect(issue?.priority).toBe(2);

      const relationships = getOutgoingRelationships(db2, "ISSUE-001", "issue");
      expect(relationships).toHaveLength(1);
      expect(relationships[0].relationship_type).toBe("implements");

      db2.close();
    });
  });

});

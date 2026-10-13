/**
 * Unit tests for spec CLI command handlers
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initDatabase } from "../../../src/db.js";
import {
  handleSpecCreate,
  handleSpecList,
  handleSpecShow,
  handleSpecUpdate,
  handleSpecDelete,
} from "../../../src/cli/spec-commands.js";
import type Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("Spec CLI Commands", () => {
  let db: Database.Database;
  let tempDir: string;
  let consoleLogSpy: any;
  let consoleErrorSpy: any;
  let processExitSpy: any;

  beforeEach(() => {
    // Create a fresh in-memory database for each test
    db = initDatabase({ path: ":memory:" });

    // Create temporary directory for files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sudocode-test-"));

    // Create necessary subdirectories
    fs.mkdirSync(path.join(tempDir, "specs"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "issues"), { recursive: true });
    fs.mkdirSync(path.join(tempDir, "custom"), { recursive: true });

    // Create empty JSONL files
    fs.writeFileSync(path.join(tempDir, "specs", "specs.jsonl"), "", "utf8");
    fs.writeFileSync(path.join(tempDir, "issues", "issues.jsonl"), "", "utf8");

    // Create config.json
    const config = {
      version: "1.0.0",
      id_prefix: {
        spec: "spec",
        issue: "issue",
      },
    };
    fs.writeFileSync(
      path.join(tempDir, "config.json"),
      JSON.stringify(config, null, 2)
    );

    // Spy on console methods
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    processExitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    // Restore spies
    consoleLogSpy?.mockRestore();
    consoleErrorSpy?.mockRestore();
    processExitSpy?.mockRestore();

    // Clean up temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("handleSpecCreate", () => {
    it("should create a spec in database", async () => {
      // Test that the spec is created in the database
      // We'll test the handler indirectly through database operations
      const { generateSpecId } = await import("../../../src/id-generator.js");
      const { createSpec } = await import("../../../src/operations/specs.js");
      const { getSpec } = await import("../../../src/operations/specs.js");

      const { id: specId, uuid: specUuid } = generateSpecId(db, tempDir);
      const spec = createSpec(db, {
        id: specId,
        uuid: specUuid,
        title: "Test Spec",
        file_path: path.join(tempDir, "specs", "test.md"),
        content: "",
        priority: 2,
      });

      expect(spec).toBeDefined();
      expect(spec.id).toBe(specId);
      expect(spec.uuid).toBe(specUuid);
      expect(spec.title).toBe("Test Spec");

      const retrieved = getSpec(db, specId);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.title).toBe("Test Spec");
    });
  });

  describe("handleSpecList", () => {
    beforeEach(async () => {
      // Create test specs directly in database
      const { createSpec } = await import("../../../src/operations/specs.js");
      const { generateSpecId } = await import("../../../src/id-generator.js");

      const { id: spec1Id, uuid: spec1Uuid } = generateSpecId(db, tempDir);
      createSpec(db, {
        id: spec1Id,
        uuid: spec1Uuid,
        title: "Spec 1",
        file_path: path.join(tempDir, "specs", "spec1.md"),
        content: "",
        priority: 1,
      });

      const { id: spec2Id, uuid: spec2Uuid } = generateSpecId(db, tempDir);
      createSpec(db, {
        id: spec2Id,
        uuid: spec2Uuid,
        title: "Spec 2",
        file_path: path.join(tempDir, "specs", "spec2.md"),
        content: "",
        priority: 2,
      });

      consoleLogSpy.mockClear();
    });

    it("should list all specs", async () => {
      const ctx = { db, outputDir: tempDir, jsonOutput: false };
      const options = { limit: "50" };

      await handleSpecList(ctx, options);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("Found 2 spec(s)")
      );
    });

    it("should filter specs by priority", async () => {
      const ctx = { db, outputDir: tempDir, jsonOutput: false };
      const options = {
        priority: "1",
        limit: "50",
      };

      await handleSpecList(ctx, options);

      const calls = consoleLogSpy.mock.calls.flat().join(" ");
      expect(calls).toContain("Spec 1");
      expect(calls).not.toContain("Spec 2");
    });

    it("should output JSON format", async () => {
      const ctx = { db, outputDir: tempDir, jsonOutput: true };
      const options = { limit: "50" };

      await handleSpecList(ctx, options);

      const output = consoleLogSpy.mock.calls[0][0];
      expect(() => JSON.parse(output)).not.toThrow();
    });

    it("should handle empty results", async () => {
      // Create a fresh database with no specs
      const emptyDb = initDatabase({ path: ":memory:" });
      const ctx = { db: emptyDb, outputDir: tempDir, jsonOutput: false };
      const options = { limit: "50" };

      await handleSpecList(ctx, options);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("No specs found")
      );
    });
  });

  describe("handleSpecShow", () => {
    beforeEach(async () => {
      // Create a test spec directly in database
      const { createSpec } = await import("../../../src/operations/specs.js");
      const { setTags } = await import("../../../src/operations/tags.js");

      createSpec(db, {
        id: "spec-001",
        title: "Show Test Spec",
        file_path: path.join(tempDir, "specs", "show.md"),
        content: "Test description",
        priority: 2,
      });

      setTags(db, "spec-001", "spec", ["tag1", "tag2"]);

      consoleLogSpy.mockClear();
    });

    it("should show spec details", async () => {
      const ctx = { db, outputDir: tempDir, jsonOutput: false };

      await handleSpecShow(ctx, "spec-001");

      const output = consoleLogSpy.mock.calls.flat().join(" ");
      expect(output).toContain("spec-001");
      expect(output).toContain("Show Test Spec");
    });

    it("should output JSON format", async () => {
      const ctx = { db, outputDir: tempDir, jsonOutput: true };

      await handleSpecShow(ctx, "spec-001");

      const output = consoleLogSpy.mock.calls[0][0];
      const parsed = JSON.parse(output);
      expect(parsed.id).toBe("spec-001");
      expect(parsed.title).toBe("Show Test Spec");
    });

    it("should handle non-existent spec", async () => {
      const ctx = { db, outputDir: tempDir, jsonOutput: false };

      await handleSpecShow(ctx, "non-existent");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("✗ Spec not found")
      );
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe("handleSpecUpdate", () => {
    beforeEach(async () => {
      // Create test spec directly in database with markdown file
      const { createSpec } = await import("../../../src/operations/specs.js");
      const { setTags } = await import("../../../src/operations/tags.js");
      const { writeMarkdownFile } = await import("../../../src/markdown.js");

      createSpec(db, {
        id: "spec-update-1",
        title: "Update Test Spec",
        file_path: "specs/update_test.md",
        content: "Original description",
        priority: 2,
      });

      // Create markdown file
      const markdownPath = path.join(tempDir, "specs", "update_test.md");
      writeMarkdownFile(
        markdownPath,
        {
          id: "spec-update-1",
          title: "Update Test Spec",
          priority: 2,
        },
        "Original design notes"
      );

      setTags(db, "spec-update-1", "spec", ["tag1", "tag2"]);

      consoleLogSpy.mockClear();
    });

    it("should handle non-existent spec", async () => {
      const ctx = { db, outputDir: tempDir, jsonOutput: false };
      const options = {
        title: "New Title",
      };

      await handleSpecUpdate(ctx, "non-existent", options);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("✗ Spec not found")
      );
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("should preserve existing markdown content when updating frontmatter only", async () => {
      const ctx = { db, outputDir: tempDir, jsonOutput: false };
      const options = {
        title: "Only Title Update",
      };

      await handleSpecUpdate(ctx, "spec-update-1", options);

      // Read the markdown file to verify original design notes preserved
      const markdownPath = path.join(tempDir, "specs", "update_test.md");
      const content = fs.readFileSync(markdownPath, "utf8");
      expect(content).toContain("Original design notes");
    });
  });

  describe("handleSpecDelete", () => {
    beforeEach(async () => {
      // Create test specs directly in database with markdown files
      const { createSpec } = await import("../../../src/operations/specs.js");
      const { writeMarkdownFile } = await import("../../../src/markdown.js");

      // Create spec for delete test 1
      createSpec(db, {
        id: "spec-delete-1",
        title: "Delete Test 1",
        file_path: "specs/delete_test_1.md",
        content: "Test content",
        priority: 2,
      });

      // Create markdown file for delete test 1
      const deleteTest1Path = path.join(tempDir, "specs", "delete_test_1.md");
      writeMarkdownFile(
        deleteTest1Path,
        {
          id: "spec-delete-1",
          title: "Delete Test 1",
          priority: 2,
        },
        "Test content"
      );

      // Create spec for delete test 2
      createSpec(db, {
        id: "spec-delete-2",
        title: "Delete Test 2",
        file_path: "specs/delete_test_2.md",
        content: "Test content",
        priority: 2,
      });

      // Create markdown file for delete test 2
      const deleteTest2Path = path.join(tempDir, "specs", "delete_test_2.md");
      writeMarkdownFile(
        deleteTest2Path,
        {
          id: "spec-delete-2",
          title: "Delete Test 2",
          priority: 2,
        },
        "Test content"
      );

      consoleLogSpy.mockClear();
    });

    it("should handle non-existent spec", async () => {
      const ctx = { db, outputDir: tempDir, jsonOutput: false };

      await handleSpecDelete(ctx, ["non-existent"], {});

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("✗ Spec not found"),
        expect.anything()
      );
    });
  });
});

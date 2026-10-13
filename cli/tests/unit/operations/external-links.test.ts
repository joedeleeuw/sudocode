/**
 * Unit tests for External Link operations
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { ExternalLink, SpecJSONL, IssueJSONL } from "@sudocode-ai/types";
import { writeJSONLSync, readJSONLSync } from "../../../src/jsonl.js";
import {
  findSpecsByExternalLink,
  getSpecExternalLinks,
  getSpecFromJsonl,
  findIssuesByExternalLink,
  getIssueExternalLinks,
  getIssueFromJsonl,
  findEntitiesByExternalLink,
} from "../../../src/operations/external-links.js";

describe("External Link Operations", () => {
  let testDir: string;

  beforeEach(() => {
    // Create a temporary directory for each test
    testDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "sudocode-external-links-test-")
    );

    // Create empty JSONL files
    writeJSONLSync(path.join(testDir, "specs.jsonl"), []);
    writeJSONLSync(path.join(testDir, "issues.jsonl"), []);
  });

  afterEach(() => {
    // Clean up temporary directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  // Helper function to create a test spec
  function createTestSpec(
    id: string,
    title: string,
    externalLinks?: ExternalLink[]
  ): SpecJSONL {
    const spec: SpecJSONL = {
      id,
      uuid: `uuid-${id}`,
      title,
      file_path: `specs/${id}.md`,
      content: `# ${title}`,
      priority: 2,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      relationships: [],
      tags: [],
      external_links: externalLinks,
    };

    const specs = readJSONLSync<SpecJSONL>(path.join(testDir, "specs.jsonl"), {
      skipErrors: true,
    });
    specs.push(spec);
    writeJSONLSync(path.join(testDir, "specs.jsonl"), specs);

    return spec;
  }

  // Helper function to create a test issue
  function createTestIssue(
    id: string,
    title: string,
    externalLinks?: ExternalLink[]
  ): IssueJSONL {
    const issue: IssueJSONL = {
      id,
      uuid: `uuid-${id}`,
      title,
      content: `# ${title}`,
      status: "open",
      priority: 2,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      relationships: [],
      tags: [],
      external_links: externalLinks,
    };

    const issues = readJSONLSync<IssueJSONL>(
      path.join(testDir, "issues.jsonl"),
      { skipErrors: true }
    );
    issues.push(issue);
    writeJSONLSync(path.join(testDir, "issues.jsonl"), issues);

    return issue;
  }

  describe("Spec External Links", () => {
    describe("findSpecsByExternalLink", () => {
      it("should find specs with matching link", () => {
        createTestSpec("s-001", "Test Spec 1", [
          {
            provider: "beads",
            external_id: "bd-abc",
            sync_enabled: true,
            sync_direction: "inbound",
          },
        ]);

        createTestSpec("s-002", "Test Spec 2");

        const found = findSpecsByExternalLink(testDir, "beads", "bd-abc");

        expect(found).toHaveLength(1);
        expect(found[0].id).toBe("s-001");
      });

      it("should return empty for no matches", () => {
        createTestSpec("s-001", "Test Spec");

        const found = findSpecsByExternalLink(testDir, "jira", "NONEXISTENT");

        expect(found).toHaveLength(0);
      });
    });

    describe("getSpecExternalLinks", () => {
      it("should return all external links for a spec", () => {
        createTestSpec("s-001", "Test Spec", [
          {
            provider: "jira",
            external_id: "PROJ-123",
            sync_enabled: true,
            sync_direction: "bidirectional",
          },
          {
            provider: "beads",
            external_id: "bd-abc",
            sync_enabled: true,
            sync_direction: "inbound",
          },
        ]);

        const links = getSpecExternalLinks(testDir, "s-001");

        expect(links).toHaveLength(2);
      });

      it("should return empty array for spec without links", () => {
        createTestSpec("s-001", "Test Spec");

        const links = getSpecExternalLinks(testDir, "s-001");

        expect(links).toHaveLength(0);
      });
    });
  });

  describe("Issue External Links", () => {
    describe("findIssuesByExternalLink", () => {
      it("should find issues with matching link", () => {
        createTestIssue("i-001", "Test Issue 1", [
          {
            provider: "jira",
            external_id: "PROJ-456",
            sync_enabled: true,
            sync_direction: "outbound",
          },
        ]);

        createTestIssue("i-002", "Test Issue 2");

        const found = findIssuesByExternalLink(testDir, "jira", "PROJ-456");

        expect(found).toHaveLength(1);
        expect(found[0].id).toBe("i-001");
      });

      it("should return empty for no matches", () => {
        createTestIssue("i-001", "Test Issue");

        const found = findIssuesByExternalLink(testDir, "jira", "NONEXISTENT");

        expect(found).toHaveLength(0);
      });
    });

    describe("getIssueExternalLinks", () => {
      it("should return all external links for an issue", () => {
        createTestIssue("i-001", "Test Issue", [
          {
            provider: "jira",
            external_id: "PROJ-456",
            sync_enabled: true,
            sync_direction: "outbound",
          },
          {
            provider: "spec-kit",
            external_id: "sk-123",
            sync_enabled: true,
            sync_direction: "inbound",
          },
        ]);

        const links = getIssueExternalLinks(testDir, "i-001");

        expect(links).toHaveLength(2);
      });

      it("should return empty array for issue without links", () => {
        createTestIssue("i-001", "Test Issue");

        const links = getIssueExternalLinks(testDir, "i-001");

        expect(links).toHaveLength(0);
      });
    });
  });

  describe("Generic Operations", () => {
    describe("findEntitiesByExternalLink", () => {
      it("should find both specs and issues with matching link", () => {
        createTestSpec("s-001", "Test Spec", [
          {
            provider: "jira",
            external_id: "PROJ-789",
            sync_enabled: true,
            sync_direction: "bidirectional",
          },
        ]);

        createTestIssue("i-001", "Test Issue", [
          {
            provider: "jira",
            external_id: "PROJ-789",
            sync_enabled: true,
            sync_direction: "bidirectional",
          },
        ]);

        const found = findEntitiesByExternalLink(testDir, "jira", "PROJ-789");

        expect(found.specs).toHaveLength(1);
        expect(found.issues).toHaveLength(1);
      });
    });
  });

  describe("JSONL Round-trip", () => {
    it("should preserve external_links through read/write cycles", () => {
      const originalLink: ExternalLink = {
        provider: "jira",
        external_id: "PROJ-123",
        external_url: "https://jira.example.com/PROJ-123",
        sync_enabled: true,
        sync_direction: "bidirectional",
        last_synced_at: "2025-01-01T00:00:00Z",
        external_updated_at: "2025-01-01T00:00:00Z",
        metadata: { custom: "value", nested: { key: 123 } },
      };

      createTestSpec("s-001", "Test Spec", [originalLink]);

      // Read back and verify
      const spec = getSpecFromJsonl(testDir, "s-001");

      expect(spec).not.toBeNull();
      expect(spec!.external_links).toHaveLength(1);

      const readLink = spec!.external_links![0];
      expect(readLink.provider).toBe(originalLink.provider);
      expect(readLink.external_id).toBe(originalLink.external_id);
      expect(readLink.external_url).toBe(originalLink.external_url);
      expect(readLink.sync_enabled).toBe(originalLink.sync_enabled);
      expect(readLink.sync_direction).toBe(originalLink.sync_direction);
      expect(readLink.last_synced_at).toBe(originalLink.last_synced_at);
      expect(readLink.external_updated_at).toBe(
        originalLink.external_updated_at
      );
      expect(readLink.metadata).toEqual(originalLink.metadata);
    });
  });
});

/**
 * Export service - handles syncing database to JSONL and Markdown files
 *
 * This service respects the `sourceOfTruth` config setting:
 * - "jsonl" (default): JSONL is authoritative, markdown is derived
 * - "markdown": Markdown is authoritative, JSONL is derived (but still exported for git tracking)
 *
 * In both modes, JSONL is always exported. The difference is handled by the CLI watcher
 * when resolving conflicts between markdown and JSONL.
 */

import type Database from "better-sqlite3";
import { exportToJSONL } from "@sudocode-ai/cli/dist/export.js";
import { importJSONLIfStale } from "@sudocode-ai/cli/dist/import.js";
import { syncJSONLToMarkdown } from "@sudocode-ai/cli/dist/sync.js";
import { getConfig, isMarkdownFirst } from "@sudocode-ai/cli/dist/config.js";
import { syncFileWithRename } from "@sudocode-ai/cli/dist/filename-generator.js";
import { getSudocodeDir } from "../utils/sudocode-dir.js";
import * as fs from "fs";
import * as path from "path";

/**
 * Execute the full export (JSONL only)
 * Note: Markdown files are not updated here to avoid triggering mass file changes.
 * Markdown updates should happen through the watcher's reverse sync if enabled,
 * or through explicit sync commands.
 *
 * This function respects the sourceOfTruth config:
 * - JSONL is always exported (for git tracking) regardless of mode
 * - The CLI watcher handles sync direction based on the config
 */
async function executeFullExport(db: Database.Database, outputDir?: string): Promise<void> {
  const dir = outputDir || getSudocodeDir();
  const config = getConfig(dir);
  const markdownFirst = isMarkdownFirst(config);

  // Export to JSONL (always done regardless of sourceOfTruth mode)
  await exportToJSONL(db, { outputDir: dir });

  if (markdownFirst) {
    // In markdown-first mode, JSONL is derived from markdown.
    // We still export to JSONL for git tracking, but the watcher
    // will prioritize markdown when there are conflicts.
    console.log("[export] JSONL exported (markdown is source of truth)");
  }
}

/**
 * Sync a single entity to its markdown file
 */
export async function syncEntityToMarkdown(
  db: Database.Database,
  entityId: string,
  entityType: "spec" | "issue",
  outputDir?: string
): Promise<void> {
  const dir = outputDir || getSudocodeDir();

  if (entityType === "issue") {
    const { getIssueById } = await import("./issues.js");
    const issue = getIssueById(db, entityId);
    if (issue) {
      const issuesDir = path.join(dir, "issues");
      const mdPath = syncFileWithRename(issue.id, issuesDir, issue.title);
      await syncJSONLToMarkdown(db, issue.id, "issue", mdPath);
    }
  } else {
    const { getSpecById } = await import("./specs.js");
    const spec = getSpecById(db, entityId);
    if (spec) {
      const specsDir = path.join(dir, "specs");
      const mdPath = spec.file_path && fs.existsSync(path.join(dir, spec.file_path))
        ? path.join(dir, spec.file_path)
        : syncFileWithRename(spec.id, specsDir, spec.title);
      await syncJSONLToMarkdown(db, spec.id, "spec", mdPath);
    }
  }
}

/**
 * Fire-and-forget export for non-request paths. Mutating API routes must use
 * persistMutation instead: only it makes the request fail when the write does
 * not reach the tracked JSONL.
 */
export function triggerExport(db: Database.Database, outputDir?: string): void {
  executeFullExport(db, outputDir).catch((error) => {
    console.error("Export failed:", error);
  });
}

/**
 * Execute export immediately (bypass debouncing)
 * Exports to both JSONL and Markdown files
 * @param db - Database connection
 * @param outputDir - Optional output directory (defaults to getSudocodeDir())
 */
export async function executeExportNow(db: Database.Database, outputDir?: string): Promise<void> {
  await executeFullExport(db, outputDir);
}

/**
 * Import the tracked JSONL when it holds changes the database has never seen.
 * Every mutating request reconciles first: applying a mutation to a stale
 * database would export over the newer JSONL on success.
 */
export async function reconcileJSONLBeforeMutation(
  db: Database.Database,
  sudocodeDir: string
): Promise<void> {
  await importJSONLIfStale(db, sudocodeDir);
}

/**
 * Apply a database mutation and persist it to the tracked JSONL, atomically.
 * The JSONL is reconciled first, then the mutation and the export commit
 * together: when the export fails the mutation rolls back, so a request only
 * succeeds once the change has reached the JSONL and no acknowledged
 * database-only entity is left behind.
 */
export async function persistMutation<T>(
  db: Database.Database,
  sudocodeDir: string,
  mutate: () => T
): Promise<T> {
  await reconcileJSONLBeforeMutation(db, sudocodeDir);
  db.prepare("BEGIN").run();
  try {
    const result = mutate();
    await executeFullExport(db, sudocodeDir);
    db.prepare("COMMIT").run();
    return result;
  } catch (error) {
    db.prepare("ROLLBACK").run();
    throw error;
  }
}

/**
 * Cleanup after export use (cancel pending work and reset).
 * Exports are immediate, so there is no pending state to clean up.
 */
export function cleanupExport(): void {}

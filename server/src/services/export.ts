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
import {
  syncJSONLToMarkdown,
  syncEntityMetadataToMarkdown as syncEntityMetadataToMarkdown_,
} from "@sudocode-ai/cli/dist/sync.js";
import { getConfig, isMarkdownFirst } from "@sudocode-ai/cli/dist/config.js";
import { syncFileWithRename } from "@sudocode-ai/cli/dist/filename-generator.js";
import { getSudocodeDir } from "../utils/sudocode-dir.js";
import * as fs from "fs";
import * as path from "path";

// Global debouncer state (keyed by database instance)
const exportDebouncers = new WeakMap<
  Database.Database,
  {
    timeoutId: NodeJS.Timeout | null;
    pending: boolean;
    outputDir?: string;
  }
>();

/**
 * Initialize or get the export debouncer for a specific database
 */
function getExportDebouncer(db: Database.Database) {
  let debouncer = exportDebouncers.get(db);
  if (!debouncer) {
    debouncer = {
      timeoutId: null,
      pending: false,
    };
    exportDebouncers.set(db, debouncer);
  }
  return debouncer;
}

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

function resolveEntityMarkdownPath(
  entity: { id: string; title: string; file_path?: string | null },
  entityType: "spec" | "issue",
  dir: string
): string {
  if (entityType === "issue") {
    return syncFileWithRename(entity.id, path.join(dir, "issues"), entity.title);
  }
  return entity.file_path && fs.existsSync(path.join(dir, entity.file_path))
    ? path.join(dir, entity.file_path)
    : syncFileWithRename(entity.id, path.join(dir, "specs"), entity.title);
}

async function loadEntity(
  db: Database.Database,
  entityId: string,
  entityType: "spec" | "issue"
) {
  if (entityType === "issue") {
    const { getIssueById } = await import("./issues.js");
    return getIssueById(db, entityId);
  }
  const { getSpecById } = await import("./specs.js");
  return getSpecById(db, entityId);
}

/**
 * Sync a single entity to its markdown file, body included.
 * For a route that changed the body in the database.
 */
export async function syncEntityToMarkdown(
  db: Database.Database,
  entityId: string,
  entityType: "spec" | "issue",
  outputDir?: string
): Promise<void> {
  const dir = outputDir || getSudocodeDir();
  const entity = await loadEntity(db, entityId, entityType);
  if (!entity) {
    return;
  }
  const mdPath = resolveEntityMarkdownPath(entity, entityType, dir);
  await syncJSONLToMarkdown(db, entity.id, entityType, mdPath);
}

/**
 * Rewrite an entity's frontmatter from the database and keep the file's body.
 * For a route that changed only metadata (relationships, status, priority,
 * parent, tags), so a body edit the database has not imported survives.
 */
export async function syncEntityMetadataToMarkdown(
  db: Database.Database,
  entityId: string,
  entityType: "spec" | "issue",
  outputDir?: string
): Promise<void> {
  const dir = outputDir || getSudocodeDir();
  const entity = await loadEntity(db, entityId, entityType);
  if (!entity) {
    return;
  }
  const mdPath = resolveEntityMarkdownPath(entity, entityType, dir);
  await syncEntityMetadataToMarkdown_(db, entity.id, entityType, mdPath);
}

/**
 * Trigger an export to JSONL and Markdown files (debounced)
 * This should be called after any database modifications
 *
 * @param db - Database instance
 * @param outputDir - Optional output directory (defaults to getSudocodeDir())
 */
export function triggerExport(db: Database.Database, outputDir?: string): void {
  const debouncer = getExportDebouncer(db);
  debouncer.pending = true;
  if (outputDir) {
    debouncer.outputDir = outputDir;
  }

  if (debouncer.timeoutId) {
    clearTimeout(debouncer.timeoutId);
  }

  debouncer.timeoutId = setTimeout(async () => {
    try {
      await executeFullExport(db, debouncer.outputDir);
    } catch (error) {
      console.error("Export failed:", error);
    } finally {
      // Reset debouncer state after export completes
      debouncer.pending = false;
      debouncer.timeoutId = null;
    }
  }, 2000); // 2 second debounce
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
 * Cleanup the export debouncer (cancel pending exports and reset)
 * Should be called when closing the database or during test cleanup
 *
 * Note: With WeakMap-based debouncers, this is now a no-op since
 * debouncers are automatically garbage collected when the database is closed
 */
export function cleanupExport(): void {
  // No-op: debouncers are now per-database and will be GC'd automatically
  // Kept for backward compatibility
}

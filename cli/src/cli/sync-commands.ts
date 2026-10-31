/**
 * CLI handlers for sync commands
 */

import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import { exportToJSONL } from "../export.js";
import { importFromJSONL } from "../import.js";
import { startWatcher, setupGracefulShutdown } from "../watcher.js";
import { syncMarkdownToJSONL, syncJSONLToMarkdown } from "../sync.js";
import { listSpecs } from "../operations/specs.js";
import { listAdrs } from "../operations/adrs.js";
import { listIssues } from "../operations/issues.js";
import { ENTITY_ROWS, getEntityRow } from "@sudocode-ai/types/entities";
import {
  generateUniqueFilename,
  findExistingEntityFile,
  syncFileWithRename,
} from "../filename-generator.js";
import { isInitialized, performInitialization } from "./init-commands.js";
import { getConfig, isMarkdownFirst } from "../config.js";

export interface CommandContext {
  db: Database.Database;
  outputDir: string;
  jsonOutput: boolean;
}

export interface SyncOptions {
  watch?: boolean;
  fromMarkdown?: boolean;
  toMarkdown?: boolean;
}

export async function handleSync(
  ctx: CommandContext,
  options: SyncOptions
): Promise<void> {
  // Check if sudocode is initialized, auto-initialize if not
  if (!isInitialized(ctx.outputDir)) {
    console.log(chalk.blue("Initializing sudocode..."));
    console.log();

    try {
      await performInitialization({
        dir: ctx.outputDir,
        jsonOutput: ctx.jsonOutput,
      });
    } catch (error) {
      console.error(chalk.red("✗ Auto-initialization failed"));
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }

    console.log();
  }

  if (options.watch) {
    // Start file watcher
    console.log(chalk.blue("Starting file watcher..."));
    console.log(chalk.gray(`  Watching: ${ctx.outputDir}`));
    console.log(chalk.gray("  Press Ctrl+C to stop"));

    const control = startWatcher({
      db: ctx.db,
      baseDir: ctx.outputDir,
      syncJSONLToMarkdown: true,
      onLog: (message) => {
        if (!ctx.jsonOutput) {
          console.log(chalk.gray(message));
        }
      },
      onError: (error) => {
        console.error(chalk.red(`[watch] Error: ${error.message}`));
      },
    });

    // Setup graceful shutdown
    setupGracefulShutdown(control);

    // Keep process alive
    await new Promise(() => {
      // This promise never resolves - the process will exit via SIGINT/SIGTERM
    });
  } else if (options.fromMarkdown) {
    // Manual sync from markdown to database
    await handleSyncFromMarkdown(ctx);
  } else if (options.toMarkdown) {
    // Manual sync from database to markdown
    await handleSyncToMarkdown(ctx);
  } else {
    // Auto-detect sync direction based on file modification times
    // TODO: Independently handle sync direction for each entity type.
    const { direction, reason } = determineSyncDirection(ctx);

    console.log(chalk.blue("Detecting sync direction..."));
    console.log(chalk.gray(`  ${reason}`));
    console.log();

    if (direction === "no-sync") {
      console.log(chalk.green("✓ Everything is in sync"));
      console.log(
        chalk.gray(
          "  Use --from-markdown or --to-markdown to force a specific direction"
        )
      );
    } else if (direction === "from-markdown") {
      console.log(
        chalk.blue("→ Syncing FROM markdown TO database (markdown is newer)")
      );
      console.log();
      await handleSyncFromMarkdown(ctx);
    } else if (direction === "to-markdown") {
      console.log(
        chalk.blue("→ Syncing FROM database TO markdown (database is newer)")
      );
      console.log();
      await handleSyncToMarkdown(ctx);
    }
  }
}

export interface ExportOptions {
  output: string;
}

export async function handleExport(
  ctx: CommandContext,
  options: ExportOptions
): Promise<void> {
  try {
    await exportToJSONL(ctx.db, { outputDir: options.output });

    if (ctx.jsonOutput) {
      console.log(
        JSON.stringify({ success: true, outputDir: options.output }, null, 2)
      );
    } else {
      console.log(chalk.green("✓ Exported to JSONL"));
      console.log(chalk.gray(`  Output: ${options.output}`));
    }
  } catch (error) {
    console.error(chalk.red("✗ Failed to export"));
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export interface ImportOptions {
  input: string;
}

export async function handleImport(
  ctx: CommandContext,
  options: ImportOptions
): Promise<void> {
  try {
    await importFromJSONL(ctx.db, { inputDir: options.input });

    if (ctx.jsonOutput) {
      console.log(
        JSON.stringify({ success: true, inputDir: options.input }, null, 2)
      );
    } else {
      console.log(chalk.green("✓ Imported from JSONL"));
      console.log(chalk.gray(`  Input: ${options.input}`));
    }
  } catch (error) {
    console.error(chalk.red("✗ Failed to import"));
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/**
 * Sync from markdown files to database
 */
async function handleSyncFromMarkdown(ctx: CommandContext): Promise<void> {
  console.log(chalk.blue("Syncing from markdown to database..."));

  let syncedCount = 0;
  let errorCount = 0;

  const syncOptions = {
    outputDir: ctx.outputDir,
    autoExport: false,
    autoInitialize: true,
    writeBackFrontmatter: true,
  };

  for (const row of ENTITY_ROWS) {
    const entityDir = path.join(ctx.outputDir, row.markdownDir);
    if (!fs.existsSync(entityDir)) continue;
    const files = findMarkdownFiles(entityDir);
    console.log(chalk.gray(`  Found ${files.length} ${row.type} files`));
    for (const file of files) {
      const result = await syncMarkdownToJSONL(ctx.db, file, syncOptions);
      if (result.success) {
        syncedCount++;
        console.log(
          chalk.gray(`  ✓ ${result.action} ${result.entityType} ${result.entityId}`)
        );
      } else {
        errorCount++;
        console.log(
          chalk.red(`  ✗ Failed to sync ${path.basename(file)}: ${result.error}`)
        );
      }
    }
  }

  // Export to JSONL
  if (syncedCount > 0) {
    await exportToJSONL(ctx.db, { outputDir: ctx.outputDir });
  }

  console.log();
  console.log(chalk.green(`✓ Synced ${syncedCount} files to database`));
  if (errorCount > 0) {
    console.log(chalk.yellow(`  ${errorCount} errors`));
  }
}

/**
 * Sync from database to markdown files
 */
async function handleSyncToMarkdown(ctx: CommandContext): Promise<void> {
  console.log(chalk.blue("Syncing from database to markdown..."));

  for (const row of ENTITY_ROWS) {
    fs.mkdirSync(path.join(ctx.outputDir, row.markdownDir), { recursive: true });
  }
  const issuesDir = path.join(
    ctx.outputDir,
    getEntityRow("issue").markdownDir
  );

  let syncedCount = 0;
  let errorCount = 0;

  const documents: Array<{
    entityType: "spec" | "adr";
    entities: Array<{ id: string; title: string; file_path: string }>;
  }> = [
    { entityType: "spec", entities: listSpecs(ctx.db) },
    { entityType: "adr", entities: listAdrs(ctx.db) },
  ];
  for (const { entityType, entities } of documents) {
    console.log(chalk.gray(`  Found ${entities.length} ${entityType} records in database`));
    const entityDir = path.join(
      ctx.outputDir,
      getEntityRow(entityType).markdownDir
    );
    for (const document of entities) {
      let filePath = path.join(ctx.outputDir, document.file_path);
      if (!fs.existsSync(filePath)) {
        filePath = syncFileWithRename(document.id, entityDir, document.title);
      }
      const result = await syncJSONLToMarkdown(ctx.db, document.id, entityType, filePath);
      if (result.success) {
        syncedCount++;
        console.log(
          chalk.gray(`  ✓ ${result.action} ${entityType} ${document.id} → ${path.basename(filePath)}`)
        );
      } else {
        errorCount++;
        console.log(
          chalk.red(`  ✗ Failed to sync ${entityType} ${document.id}: ${result.error}`)
        );
      }
    }
  }

  // Sync all issues
  const issues = listIssues(ctx.db, {});
  console.log(chalk.gray(`  Found ${issues.length} issues in database`));

  for (const issue of issues) {
    // Find existing file, rename if title changed, or generate new filename
    const filePath = syncFileWithRename(issue.id, issuesDir, issue.title);

    const result = await syncJSONLToMarkdown(
      ctx.db,
      issue.id,
      "issue",
      filePath
    );

    if (result.success) {
      syncedCount++;
      console.log(
        chalk.gray(
          `  ✓ ${result.action} issue ${issue.id} → ${path.basename(filePath)}`
        )
      );
    } else {
      errorCount++;
      console.log(
        chalk.red(`  ✗ Failed to sync issue ${issue.id}: ${result.error}`)
      );
    }
  }

  console.log();
  console.log(chalk.green(`✓ Synced ${syncedCount} entities to markdown`));
  if (errorCount > 0) {
    console.log(chalk.yellow(`  ${errorCount} errors`));
  }
}

/**
 * Helper: Find all markdown files in a directory recursively
 */
function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];

  function scan(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  }

  scan(dir);
  return results;
}

/**
 * Get the most recent modification time from a list of files
 * Returns null if no files exist
 */
function getMostRecentModTime(files: string[]): Date | null {
  if (files.length === 0) return null;

  let mostRecent: Date | null = null;

  for (const file of files) {
    try {
      const stats = fs.statSync(file);
      const mtime = stats.mtime;

      if (!mostRecent || mtime > mostRecent) {
        mostRecent = mtime;
      }
    } catch (error) {
      // Ignore files that don't exist or can't be accessed
      continue;
    }
  }

  return mostRecent;
}

/**
 * Determine sync direction based on config and timestamps
 * Direction depends on sourceOfTruth setting:
 * - "jsonl" (default): Use timestamp comparison, prefer DB in conflicts
 * - "markdown": Always sync from markdown (markdown is authoritative)
 */
function determineSyncDirection(ctx: CommandContext): {
  direction: "to-markdown" | "from-markdown" | "no-sync";
  reason: string;
} {
  // Check source of truth setting first
  const config = getConfig(ctx.outputDir);
  if (isMarkdownFirst(config)) {
    // Markdown is source of truth - always sync from markdown
    return {
      direction: "from-markdown",
      reason: "Markdown is source of truth (config.sourceOfTruth = 'markdown')",
    };
  }

  let syncToMarkdown = false;
  let syncFromMarkdown = false;
  const reasons: string[] = [];
  const entityStates: Array<{
    row: ReturnType<typeof getEntityRow>;
    entities: Array<{ updated_at: string }>;
  }> = [
    { row: getEntityRow("spec"), entities: listSpecs(ctx.db) },
    { row: getEntityRow("issue"), entities: listIssues(ctx.db) },
    { row: getEntityRow("adr"), entities: listAdrs(ctx.db) },
  ];

  for (const { row, entities } of entityStates) {
    const entityDir = path.join(ctx.outputDir, row.markdownDir);
    const markdownFiles = fs.existsSync(entityDir)
      ? findMarkdownFiles(entityDir)
      : [];
    const markdownTime = getMostRecentModTime(markdownFiles);
    const dbTime = entities.length > 0
      ? new Date(
          Math.max(...entities.map((entity) => new Date(entity.updated_at).getTime()))
        )
      : null;

    if (!dbTime && !markdownTime) {
      reasons.push(`No ${row.type} files or database entries found`);
    } else if (!dbTime && markdownTime) {
      syncFromMarkdown = true;
      reasons.push(`${row.pluralLabel} database empty, markdown exists`);
    } else if (dbTime && !markdownTime) {
      syncToMarkdown = true;
      reasons.push(`${row.label} markdown files missing, database has entries`);
    } else if (dbTime && markdownTime) {
      if (markdownTime > dbTime) {
        syncFromMarkdown = true;
        reasons.push(
          `${row.label} markdown files are newer than database (${formatTime(markdownTime)} > ${formatTime(dbTime)})`
        );
      } else if (dbTime > markdownTime) {
        syncToMarkdown = true;
        reasons.push(
          `${row.label} database is newer than markdown files (${formatTime(dbTime)} > ${formatTime(markdownTime)})`
        );
      } else {
        reasons.push(`${row.pluralLabel} are in sync`);
      }
    }
  }

  // Decide direction - prefer database (to-markdown) in conflicts since database is source of truth
  // Only sync from-markdown if markdown is clearly newer (user edited files)
  if (syncFromMarkdown && syncToMarkdown) {
    // Mixed state - prefer database as source of truth
    // This prevents stale markdown files from overwriting fresh database/JSONL data
    return {
      direction: "to-markdown",
      reason: reasons.join("; ") + " (using database as source of truth)",
    };
  } else if (syncFromMarkdown) {
    return {
      direction: "from-markdown",
      reason: reasons.join("; "),
    };
  } else if (syncToMarkdown) {
    return {
      direction: "to-markdown",
      reason: reasons.join("; "),
    };
  } else {
    return {
      direction: "no-sync",
      reason: reasons.join("; "),
    };
  }
}

/**
 * Format timestamp for display
 */
function formatTime(date: Date): string {
  return date.toISOString().replace("T", " ").substring(0, 19);
}

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
import { ENTITY_ROWS, getEntityRow, type DocumentEntityType } from "@sudocode-ai/types/entities";
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
  } else if (isMarkdownFirst(getConfig(ctx.outputDir))) {
    await handleSyncFromMarkdown(ctx);
  } else {
    console.error(chalk.red("✗ sudocode sync needs a direction"));
    console.error(
      chalk.gray(
        "  --from-markdown  the markdown files are the source (after editing bodies by hand)"
      )
    );
    console.error(
      chalk.gray(
        "  --to-markdown    the database and JSONL are the source (after a pull or an import)"
      )
    );
    console.error(
      chalk.gray(
        "  Set sourceOfTruth = \"markdown\" in .sudocode/config.json to make the bare command sync from markdown."
      )
    );
    process.exit(1);
  }
}

export interface ExportOptions {
  output?: string;
}

export async function handleExport(
  ctx: CommandContext,
  options: ExportOptions
): Promise<void> {
  const outputDir = options.output ?? ctx.outputDir;
  try {
    await exportToJSONL(ctx.db, { outputDir });

    if (ctx.jsonOutput) {
      console.log(JSON.stringify({ success: true, outputDir }, null, 2));
    } else {
      console.log(chalk.green("✓ Exported to JSONL"));
      console.log(chalk.gray(`  Output: ${outputDir}`));
    }
  } catch (error) {
    console.error(chalk.red("✗ Failed to export"));
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export interface ImportOptions {
  input?: string;
}

export async function handleImport(
  ctx: CommandContext,
  options: ImportOptions
): Promise<void> {
  const inputDir = options.input ?? ctx.outputDir;
  try {
    await importFromJSONL(ctx.db, { inputDir });

    if (ctx.jsonOutput) {
      console.log(JSON.stringify({ success: true, inputDir }, null, 2));
    } else {
      console.log(chalk.green("✓ Imported from JSONL"));
      console.log(chalk.gray(`  Input: ${inputDir}`));
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
    entityType: DocumentEntityType;
    entities: Array<{ id: string; title: string; file_path: string }>;
  }> = [
    { entityType: "spec", entities: listSpecs(ctx.db) },
    { entityType: "adr", entities: listAdrs(ctx.db) },
  ];
  for (const { entityType, entities } of documents) {
    console.log(chalk.gray(`  Found ${entities.length} ${entityType} records in database`));
    for (const document of entities) {
      const filePath = path.join(ctx.outputDir, document.file_path);
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

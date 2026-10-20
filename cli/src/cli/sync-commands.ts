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
import { listIssues } from "../operations/issues.js";
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

  const specsDir = path.join(ctx.outputDir, "specs");
  const issuesDir = path.join(ctx.outputDir, "issues");

  let syncedCount = 0;
  let errorCount = 0;

  const syncOptions = {
    outputDir: ctx.outputDir,
    autoExport: false,
    autoInitialize: true,
    writeBackFrontmatter: true,
  };

  // Sync specs
  if (fs.existsSync(specsDir)) {
    const specFiles = findMarkdownFiles(specsDir);
    console.log(chalk.gray(`  Found ${specFiles.length} spec files`));

    for (const file of specFiles) {
      const result = await syncMarkdownToJSONL(ctx.db, file, syncOptions);

      if (result.success) {
        syncedCount++;
        console.log(
          chalk.gray(
            `  ✓ ${result.action} ${result.entityType} ${result.entityId}`
          )
        );
      } else {
        errorCount++;
        console.log(
          chalk.red(
            `  ✗ Failed to sync ${path.basename(file)}: ${result.error}`
          )
        );
      }
    }
  }

  // Sync issues
  if (fs.existsSync(issuesDir)) {
    const issueFiles = findMarkdownFiles(issuesDir);
    console.log(chalk.gray(`  Found ${issueFiles.length} issue files`));

    for (const file of issueFiles) {
      const result = await syncMarkdownToJSONL(ctx.db, file, syncOptions);

      if (result.success) {
        syncedCount++;
        console.log(
          chalk.gray(
            `  ✓ ${result.action} ${result.entityType} ${result.entityId}`
          )
        );
      } else {
        errorCount++;
        console.log(
          chalk.red(
            `  ✗ Failed to sync ${path.basename(file)}: ${result.error}`
          )
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

  const specsDir = path.join(ctx.outputDir, "specs");
  const issuesDir = path.join(ctx.outputDir, "issues");

  // Ensure directories exist
  fs.mkdirSync(specsDir, { recursive: true });
  fs.mkdirSync(issuesDir, { recursive: true });

  let syncedCount = 0;
  let errorCount = 0;

  // Sync all specs
  const specs = listSpecs(ctx.db, {});
  console.log(chalk.gray(`  Found ${specs.length} specs in database`));

  for (const spec of specs) {
    // Check if file exists at stored path, otherwise use syncFileWithRename
    let filePath = path.join(ctx.outputDir, spec.file_path);
    if (!fs.existsSync(filePath)) {
      // Find existing file, rename if title changed, or generate new filename
      filePath = syncFileWithRename(spec.id, specsDir, spec.title);
    }

    const result = await syncJSONLToMarkdown(ctx.db, spec.id, "spec", filePath);

    if (result.success) {
      syncedCount++;
      console.log(
        chalk.gray(
          `  ✓ ${result.action} spec ${spec.id} → ${path.basename(filePath)}`
        )
      );
    } else {
      errorCount++;
      console.log(
        chalk.red(`  ✗ Failed to sync spec ${spec.id}: ${result.error}`)
      );
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

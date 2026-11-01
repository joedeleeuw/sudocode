/**
 * CLI handlers for init command
 */

import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import { initDatabase } from "../db.js";
import type Database from "better-sqlite3";
import { PROJECT_CONFIG_FILE, LOCAL_CONFIG_FILE, getProjectConfig } from "../config.js";
import type { StorageMode } from "@sudocode-ai/types";
import { ENTITY_ROWS } from "@sudocode-ai/types/entities";

/**
 * Build .gitignore content based on sourceOfTruth mode.
 *
 * In jsonl mode: specs/ and issues/ dirs are derived (gitignored)
 * In markdown mode: specs/ and issues/ dirs are authoritative (tracked)
 */
export function buildGitignore(sourceOfTruth: StorageMode): string {
  const lines = [
    "cache.db*",
    "worktrees/",
    "config.local.json",
    "merge-driver.log",
    "telemetry-buffer.jsonl",
    "telemetry-flush.json",
  ];

  if (sourceOfTruth === "jsonl") {
    lines.splice(1, 0, ...ENTITY_ROWS.map((row) => `${row.markdownDir}/`));
  }

  return lines.join("\n");
}

export interface InitOptions {
  dir?: string;
  jsonOutput?: boolean;
}

/**
 * Check if sudocode is initialized in a directory
 */
export function isInitialized(dir: string): boolean {
  const projectConfigPath = path.join(dir, PROJECT_CONFIG_FILE);
  const localConfigPath = path.join(dir, LOCAL_CONFIG_FILE);
  const dbPath = path.join(dir, "cache.db");
  return (
    (fs.existsSync(projectConfigPath) || fs.existsSync(localConfigPath)) &&
    fs.existsSync(dbPath) &&
    ENTITY_ROWS.every((row) =>
      fs.existsSync(path.join(dir, row.markdownDir))
    )
  );
}

/**
 * Perform sudocode initialization
 */
export async function performInitialization(
  options: InitOptions = {}
): Promise<void> {
  const dir = options.dir || path.join(process.cwd(), ".sudocode");
  const jsonOutput = options.jsonOutput || false;

  // Create directory structure
  fs.mkdirSync(dir, { recursive: true });
  for (const row of ENTITY_ROWS) {
    fs.mkdirSync(path.join(dir, row.markdownDir), { recursive: true });
  }

  // Track what was preserved
  const preserved: string[] = [];

  // Initialize database only if it doesn't exist
  const dbPath = path.join(dir, "cache.db");
  const dbExists = fs.existsSync(dbPath);
  let database: Database.Database;

  if (dbExists) {
    preserved.push("cache.db");
    // Open existing database
    database = initDatabase({ path: dbPath });
  } else {
    // Ensure the database directory exists before creating the database
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    database = initDatabase({ path: dbPath });
  }

  // Create config.json (project config, git-tracked)
  // Only create if it doesn't exist to preserve existing settings
  const projectConfigPath = path.join(dir, PROJECT_CONFIG_FILE);
  if (!fs.existsSync(projectConfigPath)) {
    const projectConfig = {
      // sourceOfTruth defaults to "jsonl" when not specified
    };
    fs.writeFileSync(
      projectConfigPath,
      JSON.stringify(projectConfig, null, 2),
      "utf8"
    );
  }

  // Create config.local.json (local config, gitignored)
  // Only create if it doesn't exist to preserve existing settings
  const localConfigPath = path.join(dir, LOCAL_CONFIG_FILE);
  if (!fs.existsSync(localConfigPath)) {
    const localConfig = {
      worktree: {
        worktreeStoragePath: ".sudocode/worktrees",
        autoCreateBranches: true,
        autoDeleteBranches: false,
        enableSparseCheckout: false,
        branchPrefix: "sudocode",
        cleanupOrphanedWorktreesOnStartup: false,
      },
      editor: {
        editorType: "vs-code",
      },
    };
    fs.writeFileSync(
      localConfigPath,
      JSON.stringify(localConfig, null, 2),
      "utf8"
    );
  }

  let hasJsonlData = false;
  for (const row of ENTITY_ROWS) {
    const jsonlPath = path.join(dir, row.jsonlFile);
    if (fs.existsSync(jsonlPath)) {
      preserved.push(row.jsonlFile);
      const content = fs.readFileSync(jsonlPath, "utf8");
      if (content.trim().length > 0) hasJsonlData = true;
    } else {
      fs.writeFileSync(jsonlPath, "", "utf8");
    }
  }

  if (hasJsonlData) {
    try {
      if (!jsonOutput) {
        console.log(chalk.blue("Importing from existing JSONL files..."));
      }
      const { importFromJSONL } = await import("../import.js");
      const result = await importFromJSONL(database, { inputDir: dir });

      // Report import results
      if (!jsonOutput) {
        if (result.specs.added > 0 || result.specs.updated > 0) {
          console.log(
            chalk.gray(
              `  Specs: ${result.specs.added} added, ${result.specs.updated} updated`
            )
          );
        }
        if (result.issues.added > 0 || result.issues.updated > 0) {
          console.log(
            chalk.gray(
              `  Issues: ${result.issues.added} added, ${result.issues.updated} updated`
            )
          );
        }
        if (result.adrs.added > 0 || result.adrs.updated > 0) {
          console.log(
            chalk.gray(
              `  ADRs: ${result.adrs.added} added, ${result.adrs.updated} updated`
            )
          );
        }
        if (result.collisions.length > 0) {
          console.log(
            chalk.yellow(`  Resolved ${result.collisions.length} ID collisions`)
          );
        }
      }
    } catch (importError) {
      // Log warning but continue with initialization
      if (!jsonOutput) {
        console.log(
          chalk.yellow(
            `  Warning: Failed to import JSONL data - ${importError instanceof Error ? importError.message : String(importError)}`
          )
        );
      }
    }
  }

  // Generate .gitignore based on sourceOfTruth config
  const gitignorePath = path.join(dir, ".gitignore");
  const projectConfig = getProjectConfig(dir);
  const sourceOfTruth: StorageMode = projectConfig.sourceOfTruth || "jsonl";
  const gitignoreContent = buildGitignore(sourceOfTruth);
  fs.writeFileSync(gitignorePath, gitignoreContent, "utf8");

  database.close();

  if (!jsonOutput) {
    console.log(chalk.green("✓ Initialized sudocode in"), chalk.cyan(dir));
    console.log(chalk.gray(`  Database: ${dbPath}`));

    if (preserved.length > 0) {
      console.log(
        chalk.yellow(`  Preserved existing: ${preserved.join(", ")}`)
      );
    }
  }
}

/**
 * Handle init command
 */
export async function handleInit(options: InitOptions): Promise<void> {
  try {
    await performInitialization(options);
  } catch (error) {
    console.error(chalk.red("✗ Initialization failed"));
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

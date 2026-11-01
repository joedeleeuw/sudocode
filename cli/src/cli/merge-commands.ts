/**
 * CLI handlers for merge conflict resolution
 */

import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type Database from "better-sqlite3";
import {
  hasGitConflictMarkers,
  parseMergeConflictFile,
  resolveEntities,
  mergeThreeWay,
  type ResolutionStats,
} from "../merge-resolver.js";
import { writeJSONL } from "../jsonl.js";
import {
  decodeSnapshotContent,
  decodeSnapshotLine,
  inferSnapshotEntityType,
  readEntitySnapshotFile,
  readPersistedSnapshot,
  snapshotFilePath,
  validateSnapshotEntities,
} from "../snapshot.js";
import { importFromJSONL } from "../import.js";
import { readGitStage } from "../git-merge.js";
import type { EntityType } from "@sudocode-ai/types";
import {
  ENTITY_ROWS,
  type EntitySnapshot,
  type EntitySnapshots,
} from "@sudocode-ai/types/entities";
import { validateProposedSnapshot } from "../proposed-graph.js";

export interface CommandContext {
  db: Database.Database;
  outputDir: string;
  jsonOutput: boolean;
}

export interface ResolveConflictsOptions {
  dryRun?: boolean;
  verbose?: boolean;
}

export interface MergeDriverOptions {
  base: string;
  ours: string;
  theirs: string;
  markerSize?: number;
}

export interface InitMergeDriverOptions {
  global?: boolean;
}

export interface RemoveMergeDriverOptions {
  global?: boolean;
}

interface ResolveFileResult {
  stats: {
    totalInput: number;
    totalOutput: number;
    conflicts: Array<{
      type: string;
      uuid: string;
      originalIds: string[];
      resolvedIds: string[];
      action: string;
    }>;
  };
  entityType: EntityType;
}

/**
 * Handle manual conflict resolution command
 *
 * Every snapshot file is decoded and every conflicted file is resolved before
 * anything is written; the combined proposed snapshot is validated once, then
 * the resolved files are written and imported.
 */
export async function handleResolveConflicts(
  ctx: CommandContext,
  options: ResolveConflictsOptions
): Promise<void> {
  const conflicted = new Set(
    ENTITY_ROWS.filter((row) =>
      hasGitConflictMarkers(snapshotFilePath(ctx.outputDir, row.type))
    ).map((row) => row.type)
  );

  if (conflicted.size === 0) {
    readPersistedSnapshot(ctx.outputDir);
    if (!ctx.jsonOutput) {
      console.log(chalk.green("✓ No merge conflicts found in JSONL files"));
    } else {
      console.log(JSON.stringify({ success: true, conflicts: 0 }));
    }
    return;
  }

  const results: Array<{ file: string } & ResolveFileResult> = [];
  const feedbackIds = new Set<string>();
  const proposeRow = async <K extends EntityType>(
    entityType: K
  ): Promise<EntitySnapshot<K>[]> => {
    const filePath = snapshotFilePath(ctx.outputDir, entityType);
    if (!conflicted.has(entityType)) {
      return readEntitySnapshotFile(filePath, entityType, feedbackIds);
    }
    if (!ctx.jsonOutput && !options.dryRun) {
      console.log(chalk.blue(`Resolving conflicts in ${path.basename(filePath)}...`));
    }
    const resolved = await resolveFile(filePath, entityType, options);
    results.push({ file: path.basename(filePath), stats: resolved.stats, entityType });
    return validateSnapshotEntities(filePath, entityType, resolved.entities, feedbackIds);
  };
  const proposed: EntitySnapshots = {
    spec: await proposeRow("spec"),
    issue: await proposeRow("issue"),
    adr: await proposeRow("adr"),
  };
  validateProposedSnapshot(proposed);

  if (!options.dryRun) {
    for (const result of results) {
      await writeJSONL(
        snapshotFilePath(ctx.outputDir, result.entityType),
        proposed[result.entityType]
      );
    }
    await importFromJSONL(ctx.db, { inputDir: ctx.outputDir });

    if (!ctx.jsonOutput) {
      console.log(chalk.green("\n✓ Re-imported to database"));
    }
  }

  if (ctx.jsonOutput) {
    console.log(JSON.stringify({ success: true, dryRun: options.dryRun === true, results }));
  } else {
    printResolveResults(results, options);
  }
}

function decodeConflictSides<K extends EntityType>(
  filePath: string,
  entityType: K
): { ours: EntitySnapshot<K>[]; theirs: EntitySnapshot<K>[] } {
  const sections = parseMergeConflictFile(fs.readFileSync(filePath, "utf8"));
  const ours: EntitySnapshot<K>[] = [];
  const theirs: EntitySnapshot<K>[] = [];
  let lineNumber = 1;
  for (const section of sections) {
    if (section.type === "clean") {
      for (const line of section.lines) {
        const entity = decodeSnapshotLine(filePath, entityType, line, lineNumber++);
        if (entity) {
          ours.push(entity);
          theirs.push(entity);
        }
      }
      continue;
    }
    const marker = section.marker;
    if (!marker) {
      throw new Error(`Conflict section in ${filePath} has no marker metadata`);
    }
    for (const [index, line] of (section.ours ?? []).entries()) {
      const entity = decodeSnapshotLine(filePath, entityType, line, marker.start + 2 + index);
      if (entity) ours.push(entity);
    }
    for (const [index, line] of (section.theirs ?? []).entries()) {
      const entity = decodeSnapshotLine(filePath, entityType, line, marker.middle + 2 + index);
      if (entity) theirs.push(entity);
    }
    lineNumber = marker.end + 2;
  }
  return { ours, theirs };
}

/**
 * Resolve conflicts in a single JSONL file
 *
 * Uses a true three-way merge when git index stages 1/2/3 are available, and
 * otherwise a two-way merge of the ours and theirs sides of the conflict
 * markers. Nothing is written here.
 */
async function resolveFile<K extends EntityType>(
  filePath: string,
  entityType: K,
  options: ResolveConflictsOptions
): Promise<{ entities: EntitySnapshot<K>[]; stats: ResolutionStats }> {
  const baseContent = readGitStage(filePath, 1);
  const oursContent = readGitStage(filePath, 2);
  const theirsContent = readGitStage(filePath, 3);

  if (options.verbose) {
    console.log(chalk.cyan(`  Attempting to read git stages for: ${filePath}`));
    console.log(chalk.cyan(`  Base stage: ${baseContent !== null ? 'found' : 'not found'}`));
    console.log(chalk.cyan(`  Ours stage: ${oursContent !== null ? 'found' : 'not found'}`));
    console.log(chalk.cyan(`  Theirs stage: ${theirsContent !== null ? 'found' : 'not found'}`));
  }

  if (baseContent !== null && oursContent !== null && theirsContent !== null) {
    if (options.verbose) {
      console.log(chalk.cyan('  Using three-way merge (YAML-based)'));
    }
    return mergeThreeWay(
      decodeSnapshotContent(`${filePath} (git stage 1)`, entityType, baseContent),
      decodeSnapshotContent(`${filePath} (git stage 2)`, entityType, oursContent),
      decodeSnapshotContent(`${filePath} (git stage 3)`, entityType, theirsContent)
    );
  }

  if (options.verbose) {
    console.log(
      chalk.yellow('  Base version unavailable, merging the ours and theirs sides of the conflict markers')
    );
  }
  const sides = decodeConflictSides(filePath, entityType);
  return resolveEntities([sides.ours, sides.theirs]);
}

/**
 * Print resolution results to console
 */
function printResolveResults(
  results: Array<{ file: string } & ResolveFileResult>,
  options: ResolveConflictsOptions
): void {
  for (const result of results) {
    const { file, stats, entityType } = result;

    console.log(chalk.bold(`\n${file}:`));
    console.log(`  Input:  ${stats.totalInput} ${entityType}s`);
    console.log(`  Output: ${stats.totalOutput} ${entityType}s`);

    if (stats.conflicts.length > 0) {
      console.log(
        chalk.yellow(`  Resolved ${stats.conflicts.length} conflict(s):`)
      );

      for (const conflict of stats.conflicts) {
        if (options.verbose) {
          console.log(`    - ${conflict.action}`);
          console.log(`      UUID: ${conflict.uuid}`);
          console.log(
            `      IDs: ${conflict.originalIds.join(", ")} → ${conflict.resolvedIds.join(", ")}`
          );
        } else {
          console.log(`    - ${conflict.action}`);
        }
      }
    }

    if (options.dryRun) {
      console.log(chalk.gray("  (dry-run - no changes written)"));
    } else {
      console.log(chalk.green("  ✓ Resolved and written"));
    }
  }
}

function mergeDriverFiles<K extends EntityType>(
  entityType: K,
  options: MergeDriverOptions
): EntitySnapshot<K>[] {
  const { entities } = mergeThreeWay(
    readEntitySnapshotFile(options.base, entityType),
    readEntitySnapshotFile(options.ours, entityType),
    readEntitySnapshotFile(options.theirs, entityType)
  );
  return validateSnapshotEntities(options.ours, entityType, entities);
}

/**
 * Handle git merge driver command
 */
export async function handleMergeDriver(
  options: MergeDriverOptions
): Promise<void> {
  const logPath = path.join(process.cwd(), ".sudocode", "merge-driver.log");

  try {
    const entityType = inferSnapshotEntityType([
      options.ours,
      options.theirs,
      options.base,
    ]);
    if (entityType === null) {
      await writeJSONL(options.ours, []);
    } else {
      await writeJSONL(options.ours, mergeDriverFiles(entityType, options));
    }

    // Exit 0 = success, git will use this result
    // Note: We don't log successful merges to avoid cluttering the repo
    process.exit(0);
  } catch (error) {
    // Re-throw test errors to avoid logging them
    if (error instanceof Error && error.message.includes("process.exit called with code")) {
      throw error;
    }

    // Only log on failure for debugging
    const logDir = path.dirname(logPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    fs.appendFileSync(
      logPath,
      `[${new Date().toISOString()}] Merge failed for: ${options.ours}\n` +
        `  Error: ${error instanceof Error ? error.message : String(error)}\n` +
        `  Base: ${options.base}\n` +
        `  Ours: ${options.ours}\n` +
        `  Theirs: ${options.theirs}\n\n`
    );

    // Exit 1 = failure, git will leave conflict markers
    console.error("Merge driver failed:", error);
    process.exit(1);
  }
}

/**
 * Handle init merge driver setup command
 */
export async function handleInitMergeDriver(
  options: InitMergeDriverOptions
): Promise<void> {
  const configFile = options.global
    ? path.join(os.homedir(), ".gitconfig")
    : path.join(process.cwd(), ".git", "config");

  // Check if .git exists (not in global mode)
  if (!options.global && !fs.existsSync(path.join(process.cwd(), ".git"))) {
    console.error(chalk.red("Error: Not in a git repository"));
    console.error("Run this command from a git repository, or use --global");
    process.exit(1);
  }

  // Add merge driver config
  const configSection = `
[merge "sudocode-jsonl"]
\tname = Sudocode JSONL automatic merge resolver
\tdriver = sudocode merge-driver --base=%O --ours=%A --theirs=%B
\trecursive = binary
`;

  // Check if already configured
  if (fs.existsSync(configFile)) {
    const content = fs.readFileSync(configFile, "utf8");
    if (content.includes('[merge "sudocode-jsonl"]')) {
      console.log(
        chalk.yellow("Merge driver already configured in git config")
      );
    } else {
      fs.appendFileSync(configFile, configSection);
      console.log(chalk.green(`✓ Added merge driver to ${configFile}`));
    }
  } else {
    fs.writeFileSync(configFile, configSection);
    console.log(chalk.green(`✓ Created ${configFile} with merge driver`));
  }

  // Add .gitattributes (only for local, not global)
  if (!options.global) {
    const gitattributesPath = path.join(process.cwd(), ".gitattributes");
    const attributesLine = ".sudocode/*.jsonl merge=sudocode-jsonl\n";

    if (fs.existsSync(gitattributesPath)) {
      const content = fs.readFileSync(gitattributesPath, "utf8");
      if (!content.includes("merge=sudocode-jsonl")) {
        fs.appendFileSync(gitattributesPath, attributesLine);
        console.log(chalk.green("✓ Added merge driver to .gitattributes"));
      } else {
        console.log(
          chalk.yellow("Merge driver already configured in .gitattributes")
        );
      }
    } else {
      fs.writeFileSync(gitattributesPath, attributesLine);
      console.log(chalk.green("✓ Created .gitattributes with merge driver"));
    }

    // Add merge-driver.log to .gitignore
    const gitignorePath = path.join(process.cwd(), ".gitignore");
    const ignoreEntry = ".sudocode/merge-driver.log";

    if (fs.existsSync(gitignorePath)) {
      const content = fs.readFileSync(gitignorePath, "utf8");
      if (!content.includes(ignoreEntry)) {
        fs.appendFileSync(gitignorePath, `\n${ignoreEntry}\n`);
        console.log(chalk.green("✓ Added merge-driver.log to .gitignore"));
      }
    } else {
      fs.writeFileSync(gitignorePath, `${ignoreEntry}\n`);
      console.log(chalk.green("✓ Created .gitignore with merge-driver.log"));
    }
  }

  // Test the setup
  console.log(chalk.bold("\nTesting merge driver setup..."));
  const testResult = await testMergeDriver();

  if (testResult.success) {
    console.log(chalk.green("✓ Merge driver is working correctly"));
  } else {
    console.log(chalk.red("✗ Merge driver test failed:"));
    console.log(chalk.red(`  ${testResult.error}`));
  }
}

/**
 * Handle remove merge driver command
 */
export async function handleRemoveMergeDriver(
  options: RemoveMergeDriverOptions
): Promise<void> {
  const configFile = options.global
    ? path.join(os.homedir(), ".gitconfig")
    : path.join(process.cwd(), ".git", "config");

  // Check if .git exists (not in global mode)
  if (!options.global && !fs.existsSync(path.join(process.cwd(), ".git"))) {
    console.error(chalk.red("Error: Not in a git repository"));
    console.error("Run this command from a git repository, or use --global");
    process.exit(1);
  }

  let removed = false;

  // Remove from git config
  if (fs.existsSync(configFile)) {
    const content = fs.readFileSync(configFile, "utf8");

    if (content.includes('[merge "sudocode-jsonl"]')) {
      // Remove the merge driver section
      const lines = content.split("\n");
      const filtered: string[] = [];
      let inSection = false;

      for (const line of lines) {
        if (line.trim() === '[merge "sudocode-jsonl"]') {
          inSection = true;
          continue;
        }

        // Check if we've hit the next section
        if (inSection && line.startsWith("[") && !line.includes("sudocode")) {
          inSection = false;
        }

        if (!inSection) {
          filtered.push(line);
        }
      }

      fs.writeFileSync(configFile, filtered.join("\n"));
      console.log(chalk.green(`✓ Removed merge driver from ${configFile}`));
      removed = true;
    } else {
      console.log(chalk.yellow("Merge driver not found in git config"));
    }
  } else {
    console.log(chalk.yellow("Git config file not found"));
  }

  // Remove from .gitattributes (only for local, not global)
  if (!options.global) {
    const gitattributesPath = path.join(process.cwd(), ".gitattributes");

    if (fs.existsSync(gitattributesPath)) {
      const content = fs.readFileSync(gitattributesPath, "utf8");

      if (content.includes("merge=sudocode-jsonl")) {
        const lines = content
          .split("\n")
          .filter((line) => !line.includes("merge=sudocode-jsonl"));

        // Remove file if it's now empty, otherwise update it
        if (lines.every((line) => !line.trim())) {
          fs.unlinkSync(gitattributesPath);
          console.log(
            chalk.green(
              "✓ Removed .gitattributes (was only used for merge driver)"
            )
          );
        } else {
          fs.writeFileSync(gitattributesPath, lines.join("\n"));
          console.log(
            chalk.green("✓ Removed merge driver from .gitattributes")
          );
        }
        removed = true;
      } else {
        console.log(chalk.yellow("Merge driver not found in .gitattributes"));
      }
    }
  }

  if (removed) {
    console.log(
      chalk.cyan(
        "\n✓ Merge driver removed. Git will now use default conflict handling for JSONL files."
      )
    );
  } else {
    console.log(
      chalk.yellow("\nNo merge driver configuration found to remove.")
    );
  }
}

/**
 * Test merge driver setup
 */
async function testMergeDriver(): Promise<{
  success: boolean;
  error?: string;
}> {
  // Create temp files for testing
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sudocode-merge-test-"));

  // Save original process.exit
  const originalExit = process.exit;
  let exitCode: number | undefined;

  try {
    const base = path.join(tmpDir, "base", "specs.jsonl");
    const ours = path.join(tmpDir, "ours", "specs.jsonl");
    const theirs = path.join(tmpDir, "theirs", "specs.jsonl");

    // Write test data
    const testEntity = {
      id: "s-test",
      uuid: "99999999-9999-4999-8999-999999999999",
      title: "Test",
      file_path: "specs/s-test.md",
      content: "Test",
      priority: 2,
      archived: false,
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-01T00:00:00Z",
      relationships: [],
      tags: [],
    };

    await writeJSONL(base, [testEntity]);
    await writeJSONL(ours, [testEntity]);
    await writeJSONL(theirs, [testEntity]);

    // Mock process.exit to capture exit code
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit called with code ${code}`);
    }) as any;

    // Test merge driver
    try {
      await handleMergeDriver({ base, ours, theirs });
    } catch (error) {
      // Expected - handleMergeDriver calls process.exit which throws
      if (error instanceof Error && !error.message.startsWith("process.exit called with code")) {
        throw error;
      }
    }

    // Restore process.exit
    process.exit = originalExit;

    // Check exit code
    if (exitCode !== 0) {
      throw new Error(`Merge driver exited with code ${exitCode}`);
    }

    // Check result
    const result = readEntitySnapshotFile(ours, "spec");
    if (result.length !== 1 || result[0].id !== "s-test") {
      throw new Error("Unexpected merge result");
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Restore process.exit
    process.exit = originalExit;
    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

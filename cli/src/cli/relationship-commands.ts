/**
 * CLI handlers for relationship commands
 */

import chalk from "chalk";
import * as path from "path";
import type Database from "better-sqlite3";
import { addRelationship } from "../operations/relationships.js";
import { exportToJSONL } from "../export.js";
import { syncJSONLToMarkdown } from "../sync.js";
import { findEntity } from "../operations/entities.js";
import { getEntityRow } from "@sudocode-ai/types/entities";
import { syncFileWithRename } from "../filename-generator.js";
import {
  isValidRelationshipType,
  getValidRelationshipTypes,
} from "../validation.js";
import { trackCommand } from "../telemetry.js";

export interface CommandContext {
  db: Database.Database;
  outputDir: string;
  jsonOutput: boolean;
}

export interface LinkOptions {
  type: string;
}

export async function handleLink(
  ctx: CommandContext,
  from: string,
  to: string,
  options: LinkOptions
): Promise<void> {
  const startTime = Date.now();
  try {
    // Validate relationship type
    if (!isValidRelationshipType(options.type)) {
      console.error(chalk.red(`✗ Invalid relationship type: ${options.type}`));
      console.error(
        chalk.gray(`Valid types: ${getValidRelationshipTypes().join(", ")}`)
      );
      process.exit(1);
    }

    const source = findEntity(ctx.db, from);
    const target = findEntity(ctx.db, to);
    if (!source) {
      console.error(chalk.red(`✗ Entity not found: ${from}`));
      process.exit(1);
    }
    if (!target) {
      console.error(chalk.red(`✗ Entity not found: ${to}`));
      process.exit(1);
    }

    addRelationship(ctx.db, {
      from_id: from,
      from_type: source.entityType,
      to_id: to,
      to_type: target.entityType,
      relationship_type: options.type,
    });

    // Export to JSONL to persist the relationship
    await exportToJSONL(ctx.db, { outputDir: ctx.outputDir });

    const sourceRow = getEntityRow(source.entityType);
    const sourcePath = "file_path" in source.entity
      ? path.join(ctx.outputDir, source.entity.file_path)
      : syncFileWithRename(
          from,
          path.join(ctx.outputDir, sourceRow.markdownDir),
          source.entity.title
        );
    await syncJSONLToMarkdown(ctx.db, from, source.entityType, sourcePath);

    if (ctx.jsonOutput) {
      console.log(
        JSON.stringify({ from, to, type: options.type, success: true }, null, 2)
      );
    } else {
      console.log(chalk.green("✓ Created relationship"));
      console.log(
        chalk.cyan(from),
        chalk.yellow(options.type),
        "→",
        chalk.cyan(to)
      );
    }
    await trackCommand(ctx.outputDir, "link", { from_id: from, to_id: to, type: options.type }, true, Date.now() - startTime);
  } catch (error) {
    await trackCommand(ctx.outputDir, "link", { from_id: from, to_id: to, type: options.type }, false, Date.now() - startTime);
    console.error(chalk.red("✗ Failed to create relationship"));
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

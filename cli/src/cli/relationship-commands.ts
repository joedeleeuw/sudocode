/**
 * CLI handlers for relationship commands
 */

import chalk from "chalk";
import * as path from "path";
import type Database from "better-sqlite3";
import { addRelationship } from "../operations/relationships.js";
import { persistMutation } from "../tracker-mutation.js";
import { syncJSONLToMarkdown } from "../sync.js";
import { getSpec } from "../operations/specs.js";
import { getIssue } from "../operations/issues.js";
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
  options: LinkOptions,
): Promise<void> {
  const startTime = Date.now();
  try {
    if (!isValidRelationshipType(options.type)) {
      console.error(chalk.red(`✗ Invalid relationship type: ${options.type}`));
      console.error(
        chalk.gray(`Valid types: ${getValidRelationshipTypes().join(", ")}`),
      );
      process.exit(1);
    }

    const relationshipType = options.type;

    let fromType: "spec" | "issue";
    let toType: "spec" | "issue";

    if (getSpec(ctx.db, from)) {
      fromType = "spec";
    } else if (getIssue(ctx.db, from)) {
      fromType = "issue";
    } else {
      console.error(chalk.red(`✗ Entity not found: ${from}`));
      process.exit(1);
    }

    if (getSpec(ctx.db, to)) {
      toType = "spec";
    } else if (getIssue(ctx.db, to)) {
      toType = "issue";
    } else {
      console.error(chalk.red(`✗ Entity not found: ${to}`));
      process.exit(1);
    }

    persistMutation(ctx.db, ctx.outputDir, () =>
      addRelationship(ctx.db, {
        from_id: from,
        from_type: fromType,
        to_id: to,
        to_type: toType,
        relationship_type: relationshipType,
      }),
    );

    if (fromType === "spec") {
      const spec = getSpec(ctx.db, from);
      if (spec) {
        const specPath = path.join(ctx.outputDir, spec.file_path);
        await syncJSONLToMarkdown(ctx.db, from, "spec", specPath);
      }
    } else {
      const issue = getIssue(ctx.db, from);
      if (issue) {
        const issuesDir = path.join(ctx.outputDir, "issues");
        const issuePath = syncFileWithRename(from, issuesDir, issue.title);
        await syncJSONLToMarkdown(ctx.db, from, "issue", issuePath);
      }
    }

    if (ctx.jsonOutput) {
      console.log(
        JSON.stringify(
          { from, to, type: options.type, success: true },
          null,
          2,
        ),
      );
    } else {
      console.log(chalk.green("✓ Created relationship"));
      console.log(
        chalk.cyan(from),
        chalk.yellow(options.type),
        "→",
        chalk.cyan(to),
      );
    }
    await trackCommand(
      ctx.outputDir,
      "link",
      { from_id: from, to_id: to, type: options.type },
      true,
      Date.now() - startTime,
    );
  } catch (error) {
    await trackCommand(
      ctx.outputDir,
      "link",
      { from_id: from, to_id: to, type: options.type },
      false,
      Date.now() - startTime,
    );
    console.error(chalk.red("✗ Failed to create relationship"));
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

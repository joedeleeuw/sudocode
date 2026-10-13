/**
 * CLI handlers for reference commands
 */

import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import { addReferenceToContent } from "../operations/references.js";
import { getSpec, updateSpec } from "../operations/specs.js";
import { getIssue, updateIssue } from "../operations/issues.js";
import { parseMarkdown, stringifyMarkdown } from "../markdown.js";
import { persistMutation } from "../tracker-mutation.js";
import {
  findExistingEntityFile,
  syncFileWithRename,
} from "../filename-generator.js";

export interface CommandContext {
  db: Database.Database;
  outputDir: string;
  jsonOutput: boolean;
}

export interface AddReferenceOptions {
  line?: string;
  text?: string;
  display?: string;
  type?: string;
  format?: "inline" | "newline";
  position?: "before" | "after";
}

/**
 * Add a reference to a spec or issue markdown file
 */
export async function handleAddReference(
  ctx: CommandContext,
  entityId: string,
  referenceId: string,
  options: AddReferenceOptions,
): Promise<void> {
  try {
    if (!options.line && !options.text) {
      console.error(chalk.red("✗ Either --line or --text must be specified"));
      process.exit(1);
    }

    if (options.line && options.text) {
      console.error(chalk.red("✗ Cannot specify both --line and --text"));
      process.exit(1);
    }

    let entity: any;
    let entityType: "spec" | "issue";
    let filePath: string;

    entity = getSpec(ctx.db, entityId);
    if (entity) {
      entityType = "spec";
      filePath = path.join(ctx.outputDir, entity.file_path);
    } else {
      entity = getIssue(ctx.db, entityId);
      if (entity) {
        entityType = "issue";
        const issuesDir = path.join(ctx.outputDir, "issues");
        filePath =
          findExistingEntityFile(entityId, issuesDir, entity.title) ??
          syncFileWithRename(entityId, issuesDir, entity.title);
      } else {
        console.error(chalk.red(`✗ Entity not found: ${entityId}`));
        process.exit(1);
      }
    }

    if (!fs.existsSync(filePath)) {
      console.error(chalk.red(`✗ File not found: ${filePath}`));
      process.exit(1);
    }

    const fileContent = fs.readFileSync(filePath, "utf8");
    const parsed = parseMarkdown(fileContent);

    const location: { line?: number; text?: string } = {};
    if (options.line) {
      const lineNumber = parseInt(options.line);
      if (isNaN(lineNumber) || lineNumber < 1) {
        console.error(chalk.red("✗ Invalid line number"));
        process.exit(1);
      }
      location.line = lineNumber;
    } else if (options.text) {
      location.text = options.text;
    }

    try {
      const updatedContent = addReferenceToContent(parsed.content, location, {
        referenceId,
        displayText: options.display,
        relationshipType: options.type,
        format: options.format || "inline",
        position: options.position || "after",
      });

      const updatedMarkdown = stringifyMarkdown(parsed.data, updatedContent);

      fs.writeFileSync(filePath, updatedMarkdown, "utf8");

      persistMutation(ctx.db, ctx.outputDir, () => {
        if (entityType === "spec") {
          updateSpec(ctx.db, entityId, { content: updatedContent });
        } else {
          updateIssue(ctx.db, entityId, { content: updatedContent });
        }
      });

      if (ctx.jsonOutput) {
        console.log(
          JSON.stringify(
            {
              entity_id: entityId,
              reference_id: referenceId,
              location: location.line
                ? `line ${location.line}`
                : `text: "${location.text}"`,
              success: true,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(chalk.green("✓ Added reference to"), chalk.cyan(entityId));
        console.log(
          chalk.gray(
            `  Reference: [[${referenceId}${options.display ? `|${options.display}` : ""}]]`,
          ),
        );
        if (options.type) {
          console.log(chalk.gray(`  Type: ${options.type}`));
        }
        if (location.line) {
          console.log(
            chalk.gray(
              `  Location: line ${location.line} (${options.position || "after"})`,
            ),
          );
        } else if (location.text) {
          console.log(chalk.gray(`  Location: after "${location.text}"`));
        }
        console.log(chalk.gray(`  Format: ${options.format || "inline"}`));
      }
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("not found")) {
          console.error(chalk.red(`✗ ${error.message}`));
        } else if (error.message.includes("out of bounds")) {
          console.error(chalk.red(`✗ ${error.message}`));
        } else {
          console.error(chalk.red("✗ Failed to add reference"));
          console.error(error.message);
        }
      }
      process.exit(1);
    }
  } catch (error) {
    console.error(chalk.red("✗ Failed to add reference"));
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

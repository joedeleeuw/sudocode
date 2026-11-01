import chalk from "chalk";
import type { Command } from "commander";
import * as path from "path";
import * as fs from "fs";
import type Database from "better-sqlite3";
import type { UpdateAdrInput } from "../operations/adrs.js";
import {
  createAdr,
  getAdr,
  listAdrs,
  searchAdrs,
  updateAdr,
} from "../operations/adrs.js";
import { generateEntityId } from "../id-generator.js";
import {
  getIncomingRelationships,
  getOutgoingRelationships,
} from "../operations/relationships.js";
import { getTags, setTags } from "../operations/tags.js";
import { listFeedback } from "../operations/feedback.js";
import { exportToJSONL } from "../export.js";
import { assertSynced, syncEntityMetadataToMarkdown, syncJSONLToMarkdown } from "../sync.js";
import { writeMarkdownFile } from "../markdown.js";
import { generateUniqueFilename } from "../filename-generator.js";
import { getEntityRow } from "@sudocode-ai/types/entities";

export interface CommandContext {
  db: Database.Database;
  outputDir: string;
  jsonOutput: boolean;
}

export interface AdrCreateOptions {
  description?: string;
  filePath?: string;
  tags?: string;
}

export async function handleAdrCreate(
  ctx: CommandContext,
  title: string,
  options: AdrCreateOptions
): Promise<void> {
  try {
    const row = getEntityRow("adr");
    const { id, uuid } = generateEntityId(ctx.db, row.type);
    const directory = path.join(ctx.outputDir, row.markdownDir);
    fs.mkdirSync(directory, { recursive: true });
    const fileName = options.filePath
      ? path.basename(options.filePath)
      : generateUniqueFilename(title, id);
    const filePath = `${row.markdownDir}/${fileName}`;
    const content = options.description ?? "";
    const adr = createAdr(ctx.db, { id, uuid, title, file_path: filePath, content });
    const tags = options.tags?.split(",").map((tag) => tag.trim()) ?? [];
    if (tags.length > 0) setTags(ctx.db, id, row.type, tags);
    writeMarkdownFile(path.join(ctx.outputDir, filePath), {
      id,
      title,
      created_at: adr.created_at,
      ...(tags.length > 0 && { tags }),
    }, content);
    await exportToJSONL(ctx.db, { outputDir: ctx.outputDir });
    if (ctx.jsonOutput) {
      console.log(JSON.stringify({ id, title, file_path: filePath }, null, 2));
    } else {
      console.log(chalk.green("✓ Created ADR"), chalk.cyan(id));
      console.log(chalk.gray(`  Title: ${title}`));
      console.log(chalk.gray(`  File: ${filePath}`));
    }
  } catch (error) {
    console.error(chalk.red("✗ Failed to create ADR"));
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export interface AdrListOptions {
  grep?: string;
  archived?: string;
  limit: string;
}

export async function handleAdrList(
  ctx: CommandContext,
  options: AdrListOptions
): Promise<void> {
  try {
    const archived = options.archived !== undefined
      ? options.archived === "true"
      : false;
    const limit = Number.parseInt(options.limit, 10);
    const adrs = options.grep
      ? searchAdrs(ctx.db, options.grep, { archived, limit })
      : listAdrs(ctx.db, { archived, limit });
    if (ctx.jsonOutput) {
      console.log(JSON.stringify(adrs, null, 2));
      return;
    }
    if (adrs.length === 0) {
      console.log(chalk.gray("No ADRs found"));
      return;
    }
    console.log(chalk.bold(`\nFound ${adrs.length} ADR(s):\n`));
    for (const adr of adrs) {
      console.log(
        chalk.cyan(adr.id),
        adr.title,
        adr.superseded ? chalk.yellow("[superseded]") : ""
      );
      console.log(chalk.gray(`  ${adr.file_path}`));
    }
    console.log();
  } catch (error) {
    console.error(chalk.red("✗ Failed to list ADRs"));
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export async function handleAdrShow(
  ctx: CommandContext,
  id: string
): Promise<void> {
  try {
    const adr = getAdr(ctx.db, id);
    if (!adr) {
      console.error(chalk.red(`✗ ADR not found: ${id}`));
      process.exit(1);
    }
    const outgoing = getOutgoingRelationships(ctx.db, id, "adr");
    const incoming = getIncomingRelationships(ctx.db, id, "adr");
    const tags = getTags(ctx.db, id, "adr");
    const feedback = listFeedback(ctx.db, { to_id: id });
    if (ctx.jsonOutput) {
      console.log(JSON.stringify({
        ...adr,
        relationships: { outgoing, incoming },
        tags,
        feedback,
      }, null, 2));
      return;
    }
    console.log();
    console.log(chalk.bold.cyan(adr.id), chalk.bold(adr.title));
    console.log(chalk.gray("─".repeat(60)));
    console.log(chalk.gray("State:"), adr.archived ? "archived" : adr.superseded ? "superseded" : "accepted");
    console.log(chalk.gray("File:"), adr.file_path);
    console.log(chalk.gray("Created:"), adr.created_at);
    console.log(chalk.gray("Updated:"), adr.updated_at);
    if (tags.length > 0) console.log(chalk.gray("Tags:"), tags.join(", "));
    if (adr.content) {
      console.log();
      console.log(chalk.bold("Content:"));
      console.log(adr.content);
    }
    if (outgoing.length > 0) {
      console.log();
      console.log(chalk.bold("Outgoing Relationships:"));
      for (const relationship of outgoing) {
        console.log(
          `  ${chalk.yellow(relationship.relationship_type)} → ${chalk.cyan(relationship.to_id)} (${relationship.to_type})`
        );
      }
    }
    if (incoming.length > 0) {
      console.log();
      console.log(chalk.bold("Incoming Relationships:"));
      for (const relationship of incoming) {
        console.log(
          `  ${chalk.cyan(relationship.from_id)} (${relationship.from_type}) → ${chalk.yellow(relationship.relationship_type)}`
        );
      }
    }
    if (feedback.length > 0) {
      console.log();
      console.log(chalk.bold("Feedback Received:"));
      for (const entry of feedback) {
        console.log(`  ${chalk.cyan(entry.id)}: ${entry.content}`);
      }
    }
    console.log();
  } catch (error) {
    console.error(chalk.red("✗ Failed to show ADR"));
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export interface AdrUpdateOptions {
  title?: string;
  description?: string;
  tags?: string;
  archived?: string;
}

async function updateAdrRecord(
  ctx: CommandContext,
  id: string,
  input: UpdateAdrInput,
  tags?: string
) {
  const existing = getAdr(ctx.db, id);
  if (!existing) throw new Error(`ADR not found: ${id}`);
  const updated = updateAdr(ctx.db, id, input);
  if (tags !== undefined) {
    setTags(ctx.db, id, "adr", tags.split(",").map((tag) => tag.trim()));
  }
  const writeMarkdown =
    input.content === undefined ? syncEntityMetadataToMarkdown : syncJSONLToMarkdown;
  assertSynced(
    await writeMarkdown(ctx.db, id, "adr", path.join(ctx.outputDir, updated.file_path))
  );
  await exportToJSONL(ctx.db, { outputDir: ctx.outputDir });
  return updated;
}

export async function handleAdrUpdate(
  ctx: CommandContext,
  id: string,
  options: AdrUpdateOptions
): Promise<void> {
  try {
    const input: UpdateAdrInput = {};
    if (options.title !== undefined) input.title = options.title;
    if (options.description !== undefined) input.content = options.description;
    if (options.archived !== undefined) input.archived = options.archived === "true";
    const updated = await updateAdrRecord(ctx, id, input, options.tags);
    if (ctx.jsonOutput) {
      console.log(JSON.stringify(updated, null, 2));
    } else {
      console.log(chalk.green("✓ Updated ADR"), chalk.cyan(id));
    }
  } catch (error) {
    console.error(chalk.red("✗ Failed to update ADR"));
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export async function handleAdrArchive(
  ctx: CommandContext,
  id: string
): Promise<void> {
  try {
    const updated = await updateAdrRecord(ctx, id, { archived: true });
    if (ctx.jsonOutput) {
      console.log(JSON.stringify(updated, null, 2));
    } else {
      console.log(chalk.green("✓ Archived ADR"), chalk.cyan(id));
    }
  } catch (error) {
    console.error(chalk.red("✗ Failed to archive ADR"));
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export function registerAdrCommands(
  program: Command,
  getContext: () => Promise<CommandContext>
): void {
  const row = getEntityRow("adr");
  const command = program
    .command(row.command)
    .alias(`${row.command}s`)
    .description(`Manage ${row.pluralLabel}`);

  command
    .command("create <title>")
    .description(`Create a new ${row.label}`)
    .option("-d, --description <desc>", "Decision context, decision, and rationale")
    .option("--file-path <path>", "File path for markdown")
    .option("--tags <tags>", "Comma-separated tags")
    .action(async (title, options) => {
      await handleAdrCreate(await getContext(), title, options);
    });

  command
    .command("list")
    .description(`List ${row.pluralLabel}`)
    .option("-g, --grep <query>", "Search by title or content")
    .option("--archived <bool>", "Filter by archive status (true/false)")
    .option("--limit <num>", "Limit results", "50")
    .action(async (options) => {
      await handleAdrList(await getContext(), options);
    });

  command
    .command("show <id>")
    .description(`Show ${row.label} details and derived supersession`)
    .action(async (id) => {
      await handleAdrShow(await getContext(), id);
    });

  command
    .command("update <id>")
    .description(`Update an ${row.label}`)
    .option("--title <title>", "New title")
    .option("-d, --description <desc>", "New content")
    .option("--tags <tags>", "New comma-separated tags")
    .option("--archived <bool>", "Archive status (true/false)")
    .action(async (id, options) => {
      await handleAdrUpdate(await getContext(), id, options);
    });

  command
    .command("archive <id>")
    .description(`Archive a withdrawn ${row.label}`)
    .action(async (id) => {
      await handleAdrArchive(await getContext(), id);
    });
}

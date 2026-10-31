import type Database from "better-sqlite3";
import type { Adr, ExternalLink } from "@sudocode-ai/types";
import { generateUUID } from "../id-generator.js";
import { getIncomingRelationships } from "./relationships.js";

export interface CreateAdrInput {
  id: string;
  uuid?: string;
  title: string;
  file_path: string;
  content?: string;
  archived?: boolean;
  archived_at?: string | null;
  created_at?: string;
  updated_at?: string;
  external_links?: string | null;
}

export interface UpdateAdrInput {
  title?: string;
  file_path?: string;
  content?: string;
  archived?: boolean;
  archived_at?: string | null;
  updated_at?: string;
  external_links?: string | null;
}

export interface ListAdrsOptions {
  archived?: boolean;
  limit?: number;
  offset?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`Invalid ADR row: ${field} must be a string`);
  }
  return value;
}

function optionalString(
  row: Record<string, unknown>,
  field: string
): string | undefined {
  const value = row[field];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid ADR row: ${field} must be a string or null`);
  }
  return value;
}

function decodeExternalLink(value: unknown): ExternalLink {
  if (!isRecord(value)) {
    throw new Error("Invalid ADR external link: expected an object");
  }
  if (
    typeof value.provider !== "string" ||
    typeof value.external_id !== "string" ||
    typeof value.sync_enabled !== "boolean" ||
    (value.sync_direction !== "inbound" &&
      value.sync_direction !== "outbound" &&
      value.sync_direction !== "bidirectional")
  ) {
    throw new Error("Invalid ADR external link fields");
  }
  const metadata = value.metadata;
  const importMetadata = value.import_metadata;
  if (metadata !== undefined && !isRecord(metadata)) {
    throw new Error("Invalid ADR external link metadata");
  }
  if (importMetadata !== undefined && !isRecord(importMetadata)) {
    throw new Error("Invalid ADR external link import_metadata");
  }
  return {
    provider: value.provider,
    external_id: value.external_id,
    external_url: optionalString(value, "external_url"),
    sync_enabled: value.sync_enabled,
    sync_direction: value.sync_direction,
    last_synced_at: optionalString(value, "last_synced_at"),
    external_updated_at: optionalString(value, "external_updated_at"),
    metadata,
    imported_at: optionalString(value, "imported_at"),
    content_hash: optionalString(value, "content_hash"),
    import_metadata: importMetadata,
  };
}

function decodeExternalLinks(value: unknown): ExternalLink[] | undefined {
  if (typeof value !== "string") return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid ADR external_links: expected an array");
  }
  return parsed.map(decodeExternalLink);
}

function decodeAdr(row: unknown): Adr | null {
  if (row === undefined || row === null) return null;
  if (!isRecord(row)) {
    throw new Error("Invalid ADR row: expected an object");
  }
  const archived = "archived" in row ? row.archived : 0;
  if (archived !== 0 && archived !== 1 && typeof archived !== "boolean") {
    throw new Error("Invalid ADR row: archived must be boolean or 0/1");
  }
  return {
    id: requiredString(row, "id"),
    uuid: requiredString(row, "uuid"),
    title: requiredString(row, "title"),
    file_path: requiredString(row, "file_path"),
    content: requiredString(row, "content"),
    archived: archived === 1 || archived === true,
    archived_at: optionalString(row, "archived_at"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
    external_links: decodeExternalLinks(
      "external_links" in row ? row.external_links : undefined
    ),
  };
}

export function createAdr(
  db: Database.Database,
  input: CreateAdrInput
): Adr {
  db.prepare(`
    INSERT INTO adrs (
      id, uuid, title, file_path, content, archived, archived_at,
      created_at, updated_at, external_links
    ) VALUES (
      @id, @uuid, @title, @file_path, @content, @archived, @archived_at,
      COALESCE(@created_at, CURRENT_TIMESTAMP),
      COALESCE(@updated_at, CURRENT_TIMESTAMP), @external_links
    )
    ON CONFLICT(id) DO UPDATE SET
      uuid = excluded.uuid,
      title = excluded.title,
      file_path = excluded.file_path,
      content = excluded.content,
      archived = excluded.archived,
      archived_at = excluded.archived_at,
      created_at = COALESCE(@created_at, adrs.created_at),
      updated_at = COALESCE(@updated_at, CURRENT_TIMESTAMP),
      external_links = excluded.external_links
  `).run({
    id: input.id,
    uuid: input.uuid ?? generateUUID(),
    title: input.title,
    file_path: input.file_path,
    content: input.content ?? "",
    archived: input.archived ? 1 : 0,
    archived_at: input.archived_at ?? null,
    created_at: input.created_at ?? null,
    updated_at: input.updated_at ?? null,
    external_links: input.external_links ?? null,
  });
  const adr = getAdr(db, input.id);
  if (!adr) throw new Error(`Failed to create ADR ${input.id}`);
  return adr;
}

export function getAdr(db: Database.Database, id: string): Adr | null {
  return decodeAdr(db.prepare("SELECT * FROM adrs WHERE id = ?").get(id));
}

export function getAdrByFilePath(
  db: Database.Database,
  filePath: string
): Adr | null {
  return decodeAdr(
    db.prepare("SELECT * FROM adrs WHERE file_path = ?").get(filePath)
  );
}

export function updateAdr(
  db: Database.Database,
  id: string,
  input: UpdateAdrInput
): Adr {
  const existing = getAdr(db, id);
  if (!existing) throw new Error(`ADR not found: ${id}`);

  const updates: string[] = [];
  const params: Record<string, string | number | null> = { id };
  if (input.title !== undefined && input.title !== existing.title) {
    updates.push("title = @title");
    params.title = input.title;
  }
  if (input.file_path !== undefined && input.file_path !== existing.file_path) {
    updates.push("file_path = @file_path");
    params.file_path = input.file_path;
  }
  if (input.content !== undefined && input.content !== existing.content) {
    updates.push("content = @content");
    params.content = input.content;
  }
  if (input.archived !== undefined && input.archived !== existing.archived) {
    updates.push("archived = @archived");
    params.archived = input.archived ? 1 : 0;
    updates.push("archived_at = @archived_at");
    params.archived_at = input.archived
      ? input.archived_at ?? new Date().toISOString()
      : null;
  } else if (input.archived_at !== undefined) {
    updates.push("archived_at = @archived_at");
    params.archived_at = input.archived_at;
  }
  if (input.external_links !== undefined) {
    updates.push("external_links = @external_links");
    params.external_links = input.external_links;
  }
  if (updates.length === 0 && input.updated_at === undefined) return existing;
  updates.push("updated_at = @updated_at");
  params.updated_at = input.updated_at ?? new Date().toISOString();

  db.prepare(`UPDATE adrs SET ${updates.join(", ")} WHERE id = @id`).run(params);
  const updated = getAdr(db, id);
  if (!updated) throw new Error(`Failed to update ADR ${id}`);
  return updated;
}

export function deleteAdr(db: Database.Database, id: string): boolean {
  db.prepare("DELETE FROM issue_feedback WHERE to_id = ?").run(id);
  db.prepare(`
    DELETE FROM relationships
    WHERE (from_id = ? AND from_type = 'adr')
       OR (to_id = ? AND to_type = 'adr')
  `).run(id, id);
  return db.prepare("DELETE FROM adrs WHERE id = ?").run(id).changes > 0;
}

export function listAdrs(
  db: Database.Database,
  options: ListAdrsOptions = {}
): Adr[] {
  const conditions: string[] = [];
  const params: Record<string, number> = {};
  if (options.archived !== undefined) {
    conditions.push("archived = @archived");
    params.archived = options.archived ? 1 : 0;
  }
  let query = "SELECT * FROM adrs";
  if (conditions.length > 0) query += ` WHERE ${conditions.join(" AND ")}`;
  query += " ORDER BY created_at DESC, id ASC";
  if (options.limit !== undefined) {
    query += " LIMIT @limit";
    params.limit = options.limit;
  }
  if (options.offset !== undefined) {
    query += " OFFSET @offset";
    params.offset = options.offset;
  }
  return db.prepare(query).all(params).map(decodeAdr).filter((adr) => adr !== null);
}

export function searchAdrs(
  db: Database.Database,
  query: string,
  options: Omit<ListAdrsOptions, "offset"> = {}
): Adr[] {
  const conditions = ["(title LIKE @query OR content LIKE @query)"];
  const params: Record<string, string | number> = { query: `%${query}%` };
  if (options.archived !== undefined) {
    conditions.push("archived = @archived");
    params.archived = options.archived ? 1 : 0;
  }
  let sql = `SELECT * FROM adrs WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC, id ASC`;
  sql += " LIMIT @limit";
  params.limit = options.limit ?? 50;
  return db.prepare(sql).all(params).map(decodeAdr).filter((adr) => adr !== null);
}

export function isAdrSuperseded(db: Database.Database, id: string): boolean {
  return getIncomingRelationships(db, id, "adr", "supersedes").length > 0;
}

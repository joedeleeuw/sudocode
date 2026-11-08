/**
 * JSONL (JSON Lines) reader and writer
 * Supports reading and writing .jsonl files for specs, issues, and ADRs
 */

import * as fs from "fs";
import * as readline from "readline";
import * as path from "path";
import type { EntitySnapshot } from "@sudocode-ai/types/entities";
import type { ExternalLink, FeedbackJSONL, RelationshipJSONL } from "./types.js";

export type JSONLEntity = EntitySnapshot;

export interface ReadJSONLOptions {
  /**
   * Skip malformed lines instead of throwing
   */
  skipErrors?: boolean;
  /**
   * Custom error handler for malformed lines
   */
  onError?: (lineNumber: number, line: string, error: Error) => void;
}

export interface WriteJSONLOptions {
  /**
   * Use atomic write (write to temp file, then rename)
   */
  atomic?: boolean;
}

/**
 * Read a JSONL file and parse all lines
 * Uses streaming for memory efficiency with large files
 */
export async function readJSONL<T = JSONLEntity>(
  filePath: string,
  options: ReadJSONLOptions = {}
): Promise<T[]> {
  const { skipErrors = false, onError } = options;

  // Check if file exists
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const entities: T[] = [];
  const fileStream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let lineNumber = 0;

  for await (const line of rl) {
    lineNumber++;

    // Skip empty lines
    if (line.trim() === "") {
      continue;
    }

    try {
      const entity = JSON.parse(line) as T;
      entities.push(entity);
    } catch (error) {
      const parseError = error as Error;

      if (onError) {
        onError(lineNumber, line, parseError);
      }

      if (!skipErrors) {
        throw new Error(
          `Failed to parse JSON at line ${lineNumber}: ${parseError.message}`
        );
      }
    }
  }

  return entities;
}

/**
 * Read a JSONL file synchronously (for smaller files)
 */
export function readJSONLSync<T = JSONLEntity>(
  filePath: string,
  options: ReadJSONLOptions = {}
): T[] {
  const { skipErrors = false, onError } = options;

  // Check if file exists
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const entities: T[] = [];
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const lineNumber = i + 1;

    // Skip empty lines
    if (line === "") {
      continue;
    }

    try {
      const entity = JSON.parse(line) as T;
      entities.push(entity);
    } catch (error) {
      const parseError = error as Error;

      if (onError) {
        onError(lineNumber, line, parseError);
      }

      if (!skipErrors) {
        throw new Error(
          `Failed to parse JSON at line ${lineNumber}: ${parseError.message}`
        );
      }
    }
  }

  return entities;
}

/**
 * Sort entities by created_at date to minimize merge conflicts
 */
function sortByCreatedAt<T>(entities: T[]): T[] {
  return [...entities].sort((a, b) => {
    const aDate = (a as any).created_at;
    const bDate = (b as any).created_at;

    // Handle missing created_at fields - put them at the end
    if (!aDate && !bDate) {
      // Both missing dates, sort by ID
      const aId = (a as any).id || "";
      const bId = (b as any).id || "";
      return aId < bId ? -1 : aId > bId ? 1 : 0;
    }
    if (!aDate) return 1;
    if (!bDate) return -1;

    // Compare dates as strings (ISO 8601 format sorts lexicographically)
    if (aDate < bDate) return -1;
    if (aDate > bDate) return 1;

    // If dates are equal, fall back to ID comparison
    const aId = (a as any).id || "";
    const bId = (b as any).id || "";
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });
}

/**
 * Sort relationships for deterministic JSONL output
 * Sorts by: to_id, then to_type, then relationship type
 */
export function sortRelationships(rels: RelationshipJSONL[]): RelationshipJSONL[] {
  return [...rels].sort((a, b) => {
    if (a.to !== b.to) return a.to.localeCompare(b.to);
    if (a.to_type !== b.to_type) return a.to_type.localeCompare(b.to_type);
    return a.type.localeCompare(b.type);
  });
}

/**
 * Sort tags alphabetically for deterministic JSONL output
 */
export function sortTags(tags: string[]): string[] {
  return [...tags].sort((a, b) => a.localeCompare(b));
}

/**
 * Sort feedback for deterministic JSONL output
 * Sorts by: id (stable identifier)
 */
export function sortFeedback(feedback: FeedbackJSONL[]): FeedbackJSONL[] {
  return [...feedback].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Sort external links for deterministic JSONL output
 * Sorts by: provider, then external_id
 */
export function sortExternalLinks(links: ExternalLink[] | undefined): ExternalLink[] | undefined {
  if (!links || links.length === 0) return links;
  return [...links].sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.external_id.localeCompare(b.external_id);
  });
}

/**
 * Values the persisted record holds where a decoded snapshot leaves a field undefined.
 * The persisted form is the database row that export writes: nullable columns are
 * explicit nulls and archived is the 0/1 column.
 */
const ENTITY_UNSET: Record<string, null | 0> = {
  assignee: null,
  archived: 0,
  archived_at: null,
  closed_at: null,
  parent_id: null,
  parent_uuid: null,
};
const FEEDBACK_UNSET: Record<string, null | false> = {
  from_id: null,
  agent: null,
  anchor: null,
  dismissed: false,
};

function fillUnset<T extends object>(record: T, unset: Record<string, unknown>): T {
  const filled: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    filled[key] = value === undefined && key in unset ? unset[key] : value;
  }
  return filled as T;
}

/**
 * The one persisted form of a snapshot record, whichever path produced it.
 * Export writes database rows; merge, conflict resolution and worktree sync write
 * decoded snapshots. Without this they disagree on nulls, archived and array order,
 * and every write by one rewrites every record the other wrote.
 */
function canonicalRecord<T>(entity: T): T {
  if (typeof entity !== "object" || entity === null) return entity;
  const record = fillUnset(entity as Record<string, unknown>, ENTITY_UNSET);
  if (typeof record.archived === "boolean") record.archived = record.archived ? 1 : 0;
  if (Array.isArray(record.relationships)) {
    record.relationships = sortRelationships(record.relationships as RelationshipJSONL[]);
  }
  if (Array.isArray(record.tags)) record.tags = sortTags(record.tags as string[]);
  if (Array.isArray(record.external_links)) {
    record.external_links = sortExternalLinks(record.external_links as ExternalLink[]);
  }
  if (Array.isArray(record.feedback)) {
    const feedback = record.feedback as FeedbackJSONL[];
    record.feedback =
      feedback.length > 0
        ? sortFeedback(feedback.map((entry) => fillUnset(entry, FEEDBACK_UNSET)))
        : undefined;
  }
  return record as T;
}

function serializeJSONL<T>(entities: T[]): string {
  return entities.map((entity) => JSON.stringify(canonicalRecord(entity))).join("\n") + "\n";
}

/**
 * Write entities to a JSONL file
 * Each entity is written as a single line of JSON
 * Entities are sorted by created_at date to minimize merge conflicts
 */
export async function writeJSONL<T = JSONLEntity>(
  filePath: string,
  entities: T[],
  options: WriteJSONLOptions = {}
): Promise<void> {
  const { atomic = true } = options;

  // Ensure directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const targetPath = atomic ? `${filePath}.tmp` : filePath;

  const sortedEntities = sortByCreatedAt(entities);
  const content = serializeJSONL(sortedEntities);

  // Check if content has actually changed before writing
  // This prevents unnecessary file writes that trigger watcher events
  if (fs.existsSync(filePath)) {
    const existingContent = fs.readFileSync(filePath, "utf8");
    if (existingContent === content) {
      // Content unchanged, skip write
      return;
    }
  }

  fs.writeFileSync(targetPath, content, "utf8");

  // Atomic rename if requested
  if (atomic) {
    fs.renameSync(targetPath, filePath);
  }

  // Set file modification time to match the newest updated_at timestamp
  // This ensures filesystem mtime reflects content timestamps for accurate sync direction detection
  if (sortedEntities.length > 0) {
    const timestamps = sortedEntities
      .map((e) => (e as any).updated_at)
      .filter((t) => t != null)
      .map((t) => {
        // Append 'Z' if not present to force UTC interpretation
        const timestamp = String(t);
        const hasZone =
          timestamp.endsWith("Z") ||
          timestamp.includes("+") ||
          /[+-]\d{2}:\d{2}$/.test(timestamp);
        const utcTimestamp = hasZone
          ? timestamp
          : timestamp.replace(" ", "T") + "Z";
        return new Date(utcTimestamp).getTime();
      });

    if (timestamps.length > 0) {
      const newestTimestamp = Math.max(...timestamps);
      const mtimeDate = new Date(newestTimestamp);
      fs.utimesSync(filePath, mtimeDate, mtimeDate);
    }
  }
}

/**
 * Write entities to a JSONL file synchronously
 * Entities are sorted by created_at date to minimize merge conflicts
 */
export function writeJSONLSync<T = JSONLEntity>(
  filePath: string,
  entities: T[],
  options: WriteJSONLOptions = {}
): void {
  const { atomic = true } = options;

  // Ensure directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const targetPath = atomic ? `${filePath}.tmp` : filePath;

  const sortedEntities = sortByCreatedAt(entities);
  const content = serializeJSONL(sortedEntities);

  // Check if content has actually changed before writing
  // This prevents unnecessary file writes that trigger watcher events
  if (fs.existsSync(filePath)) {
    const existingContent = fs.readFileSync(filePath, "utf8");
    if (existingContent === content) {
      // Content unchanged, skip write
      return;
    }
  }

  fs.writeFileSync(targetPath, content, "utf8");

  // Atomic rename if requested
  if (atomic) {
    fs.renameSync(targetPath, filePath);
  }

  // Set file modification time to match the newest updated_at timestamp
  // This ensures filesystem mtime reflects content timestamps for accurate sync direction detection
  if (sortedEntities.length > 0) {
    const timestamps = sortedEntities
      .map((e) => (e as any).updated_at)
      .filter((t) => t != null)
      .map((t) => {
        // Append 'Z' if not present to force UTC interpretation
        const timestamp = String(t);
        const hasZone =
          timestamp.endsWith("Z") ||
          timestamp.includes("+") ||
          /[+-]\d{2}:\d{2}$/.test(timestamp);
        const utcTimestamp = hasZone
          ? timestamp
          : timestamp.replace(" ", "T") + "Z";
        return new Date(utcTimestamp).getTime();
      });

    if (timestamps.length > 0) {
      const newestTimestamp = Math.max(...timestamps);
      const mtimeDate = new Date(newestTimestamp);
      fs.utimesSync(filePath, mtimeDate, mtimeDate);
    }
  }
}

/**
 * Update a single line in a JSONL file by entity ID
 * If the entity doesn't exist, append it
 * If it exists, replace the line
 */
export async function updateJSONLLine<T = JSONLEntity>(
  filePath: string,
  entity: T,
  idField: string = "id"
): Promise<void> {
  const entityId = (entity as any)[idField];

  if (!entityId) {
    throw new Error(`Entity missing ${idField} field`);
  }

  // Read existing entities
  const entities = await readJSONL<T>(filePath, { skipErrors: true });

  // Find and update or append
  const index = entities.findIndex((e: any) => e[idField] === entityId);

  if (index >= 0) {
    // Replace existing
    entities[index] = entity;
  } else {
    // Append new
    entities.push(entity);
  }

  // Write back
  await writeJSONL(filePath, entities);
}

/**
 * Update a single line in a JSONL file synchronously
 */
export function updateJSONLLineSync<T = JSONLEntity>(
  filePath: string,
  entity: T,
  idField: string = "id"
): void {
  const entityId = (entity as any)[idField];

  if (!entityId) {
    throw new Error(`Entity missing ${idField} field`);
  }

  // Read existing entities
  const entities = readJSONLSync<T>(filePath, { skipErrors: true });

  // Find and update or append
  const index = entities.findIndex((e: any) => e[idField] === entityId);

  if (index >= 0) {
    // Replace existing
    entities[index] = entity;
  } else {
    // Append new
    entities.push(entity);
  }

  // Write back
  writeJSONLSync(filePath, entities);
}

/**
 * Delete an entity from a JSONL file by ID
 */
export async function deleteJSONLLine<T = JSONLEntity>(
  filePath: string,
  entityId: string,
  idField: string = "id"
): Promise<boolean> {
  // Read existing entities
  const entities = await readJSONL<T>(filePath, { skipErrors: true });

  // Filter out the entity
  const initialLength = entities.length;
  const filtered = entities.filter((e: any) => e[idField] !== entityId);

  if (filtered.length === initialLength) {
    return false; // Nothing deleted
  }

  // Write back
  await writeJSONL(filePath, filtered);
  return true;
}

/**
 * Delete an entity from a JSONL file synchronously
 */
export function deleteJSONLLineSync<T = JSONLEntity>(
  filePath: string,
  entityId: string,
  idField: string = "id"
): boolean {
  // Read existing entities
  const entities = readJSONLSync<T>(filePath, { skipErrors: true });

  // Filter out the entity
  const initialLength = entities.length;
  const filtered = entities.filter((e: any) => e[idField] !== entityId);

  if (filtered.length === initialLength) {
    return false; // Nothing deleted
  }

  // Write back
  writeJSONLSync(filePath, filtered);
  return true;
}

/**
 * Get a single entity from a JSONL file by ID
 */
export async function getJSONLEntity<T = JSONLEntity>(
  filePath: string,
  entityId: string,
  idField: string = "id"
): Promise<T | null> {
  const entities = await readJSONL<T>(filePath, { skipErrors: true });
  return entities.find((e: any) => e[idField] === entityId) ?? null;
}

/**
 * Get a single entity from a JSONL file synchronously
 */
export function getJSONLEntitySync<T = JSONLEntity>(
  filePath: string,
  entityId: string,
  idField: string = "id"
): T | null {
  const entities = readJSONLSync<T>(filePath, { skipErrors: true });
  return entities.find((e: any) => e[idField] === entityId) ?? null;
}

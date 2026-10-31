/**
 * ID generation utilities
 *
 * Supports two ID formats:
 * 1. Legacy: SPEC-001, ISSUE-001 (sequential numbers)
 * 2. Hash-based: s-x7k9, i-a3f2 (UUID-derived base36 hashes)
 *
 * New entities use hash-based IDs for better distributed workflow support.
 * Legacy IDs remain supported indefinitely.
 */

import * as crypto from "crypto";
import type Database from "better-sqlite3";
import type { EntityType } from "@sudocode-ai/types";
import { ENTITY_ROWS, getEntityRow } from "@sudocode-ai/types/entities";

/**
 * Calculate adaptive hash length based on entity count
 * Uses birthday paradox probability to determine safe length
 *
 * Target: Keep collision probability under 25%
 * Base36 namespace sizes:
 * - 4 chars: ~1.7M namespace → ~980 items at 25% collision prob
 * - 5 chars: ~60M namespace → ~5.9K items at 25% collision prob
 * - 6 chars: ~2.2B namespace → ~35K items at 25% collision prob
 * - 7 chars: ~78B namespace → ~212K items at 25% collision prob
 * - 8 chars: ~2.8T namespace → ~1M+ items at 25% collision prob
 */
export function getAdaptiveHashLength(count: number): number {
  if (count < 980) return 4; // i-x7k9
  if (count < 5900) return 5; // i-x7k9p
  if (count < 35000) return 6; // i-x7k9p1
  if (count < 212000) return 7; // i-x7k9p1a
  return 8; // i-x7k9p1a4
}

/**
 * Convert UUID to base36 hash
 * Takes first N hex digits of SHA256(UUID) and converts to base36
 */
export function hashUUIDToBase36(uuid: string, length: number): string {
  // Remove hyphens from UUID
  const cleanUUID = uuid.replace(/-/g, "");

  // Hash the UUID with SHA256 for better distribution
  const hash = crypto.createHash("sha256").update(cleanUUID).digest("hex");

  // Take enough hex chars to generate desired base36 length
  // Each base36 char needs ~1.29 hex chars (log(36)/log(16))
  const hexCharsNeeded = Math.ceil(length * 1.29);
  const hexSubstring = hash.substring(0, hexCharsNeeded);

  // Convert hex to bigint, then to base36
  const bigInt = BigInt("0x" + hexSubstring);
  let result = bigInt.toString(36).toLowerCase();

  // Pad with zeros if needed
  if (result.length < length) {
    result = result.padStart(length, "0");
  }

  // Truncate to exact length if needed
  if (result.length > length) {
    result = result.substring(0, length);
  }

  return result;
}

function countEntities(db: Database.Database, entityType: EntityType): number {
  const row = getEntityRow(entityType);
  const result: unknown = db
    .prepare(`SELECT COUNT(*) as count FROM ${row.table}`)
    .get();
  if (
    typeof result !== "object" ||
    result === null ||
    !("count" in result) ||
    typeof result.count !== "number"
  ) {
    throw new Error(`Failed to count ${row.pluralLabel}`);
  }
  return result.count;
}

function generateHashIDFromUUID(
  db: Database.Database,
  uuid: string,
  entityType: EntityType,
  count: number
): string {
  const row = getEntityRow(entityType);
  const baseLength = getAdaptiveHashLength(count);

  // Try progressively longer hashes on collision (very rare)
  for (let length = baseLength; length <= 8; length++) {
    const hash = hashUUIDToBase36(uuid, length);
    const candidate = `${row.prefix}-${hash}`;
    const result: unknown = db
      .prepare(`SELECT COUNT(*) as count FROM ${row.table} WHERE id = ?`)
      .get(candidate);
    if (
      typeof result !== "object" ||
      result === null ||
      !("count" in result) ||
      typeof result.count !== "number"
    ) {
      throw new Error(`Failed to check ID collision for ${candidate}`);
    }
    if (result.count === 0) return candidate;
  }

  throw new Error(
    `Failed to generate unique hash ID for ${entityType} after trying lengths ${baseLength}-8`
  );
}

/**
 * Check if ID is legacy format (SPEC-001, ISSUE-001)
 */
export function isLegacyID(id: string): boolean {
  return /^(SPEC|ISSUE)-\d+$/.test(id);
}

/**
 * Check if ID is hash format (i-x7k9, s-a3f2, a-p4m8)
 */
export function isHashID(id: string): boolean {
  const prefix = id.split("-", 1)[0];
  return (
    ENTITY_ROWS.some((row) => row.prefix === prefix) &&
    /^[a-z]-[0-9a-z]{4,8}$/.test(id)
  );
}

export function generateEntityId(
  db: Database.Database,
  entityType: EntityType
): { id: string; uuid: string } {
  const uuid = crypto.randomUUID();
  const id = generateHashIDFromUUID(
    db,
    uuid,
    entityType,
    countEntities(db, entityType)
  );
  return { id, uuid };
}

export function generateSpecId(
  db: Database.Database,
  _outputDir: string
): { id: string; uuid: string } {
  return generateEntityId(db, "spec");
}

export function generateIssueId(
  db: Database.Database,
  _outputDir: string
): { id: string; uuid: string } {
  return generateEntityId(db, "issue");
}

export function generateAdrId(
  db: Database.Database,
  _outputDir: string
): { id: string; uuid: string } {
  return generateEntityId(db, "adr");
}

/**
 * Get next spec number from database
 * Strategy:
 * 1. Find the latest spec by created_at
 * 2. Extract number from its ID
 * 3. Increment by 1
 * 4. Fallback to count + 1 if extraction fails
 */
function getNextSpecNumber(db: Database.Database): number {
  const stmt = db.prepare(`
    SELECT id FROM specs
    ORDER BY created_at DESC
    LIMIT 1
  `);

  const latest = stmt.get() as { id: string } | undefined;

  if (latest) {
    const match = latest.id.match(/(\d+)$/);
    if (match) {
      return parseInt(match[1], 10) + 1;
    }
  }

  // Fallback: count + 1
  const countStmt = db.prepare(`SELECT COUNT(*) as count FROM specs`);
  const result = countStmt.get() as { count: number };
  return result.count + 1;
}

/**
 * Get next issue number from database
 * Strategy:
 * 1. Find the latest issue by created_at
 * 2. Extract number from its ID
 * 3. Increment by 1
 * 4. Fallback to count + 1 if extraction fails
 */
function getNextIssueNumber(db: Database.Database): number {
  const stmt = db.prepare(`
    SELECT id FROM issues
    ORDER BY created_at DESC
    LIMIT 1
  `);

  const latest = stmt.get() as { id: string } | undefined;

  if (latest) {
    const match = latest.id.match(/(\d+)$/);
    if (match) {
      return parseInt(match[1], 10) + 1;
    }
  }

  // Fallback: count + 1
  const countStmt = db.prepare(`SELECT COUNT(*) as count FROM issues`);
  const result = countStmt.get() as { count: number };
  return result.count + 1;
}

/**
 * Generate a UUID v4
 */
export function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * Infer entity type from ID
 * Supports both hash-based (i-xxxx, s-xxxx) and legacy (ISSUE-xxx, SPEC-xxx) formats
 */
export function getEntityTypeFromId(id: string): EntityType {
  for (const row of ENTITY_ROWS) {
    if (id.startsWith(`${row.prefix}-`) || id.startsWith(`${row.label.toUpperCase()}-`)) {
      return row.type;
    }
  }
  throw new Error(`Cannot infer entity type from ID: ${id}`);
}

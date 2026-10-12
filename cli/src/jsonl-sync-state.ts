/**
 * Tracks which JSONL content the cache database has seen.
 *
 * `.sudocode/cache.db` is a gitignored cache of the git-tracked JSONL files.
 * A fresh clone or worktree starts with an empty database, and a pull, merge
 * or checkout changes the JSONL underneath an existing one. The database
 * records the SHA-256 of each JSONL file as it last imported or exported it
 * (table `jsonl_sync_state`). A file whose digest differs from the recorded one
 * holds changes the database has never imported.
 */

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";

export interface JSONLSnapshot<T> {
  filePath: string;
  /** SHA-256 of the file bytes; null when the file does not exist */
  sha256: string | null;
  entities: T[];
}

/**
 * Read a JSONL file and its digest in one read, so the digest describes
 * exactly the entities returned. Malformed lines throw: skipping one would
 * make its entity look deleted to import and export.
 */
export function readJSONLSnapshot<T>(filePath: string): JSONLSnapshot<T> {
  let content: Buffer;
  try {
    content = fs.readFileSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { filePath, sha256: null, entities: [] };
    }
    throw error;
  }

  const entities: T[] = [];
  const lines = content.toString("utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    try {
      entities.push(JSON.parse(lines[i]) as T);
    } catch (error) {
      throw new Error(
        `${filePath}:${i + 1} is not valid JSON (${(error as Error).message}). ` +
          "Fix the file (after a merge: `sudocode resolve-conflicts`) before running sudocode."
      );
    }
  }

  return {
    filePath,
    sha256: createHash("sha256").update(content).digest("hex"),
    entities,
  };
}

/**
 * True when the database last imported or exported exactly this file content.
 */
export function isJSONLSynced(
  db: Database.Database,
  snapshot: JSONLSnapshot<unknown>
): boolean {
  const row = db
    .prepare("SELECT sha256 FROM jsonl_sync_state WHERE file_path = ?")
    .get(path.resolve(snapshot.filePath)) as
    | { sha256: string | null }
    | undefined;
  return row !== undefined && row.sha256 === snapshot.sha256;
}

/**
 * Record that the database now holds exactly the content of this snapshot.
 */
export function recordJSONLSync(
  db: Database.Database,
  snapshot: JSONLSnapshot<unknown>
): void {
  db.prepare(
    `INSERT INTO jsonl_sync_state (file_path, sha256, synced_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(file_path) DO UPDATE SET
       sha256 = excluded.sha256,
       synced_at = excluded.synced_at`
  ).run(path.resolve(snapshot.filePath), snapshot.sha256);
}

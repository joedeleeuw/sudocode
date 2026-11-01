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

export interface JSONLFileDigest {
  filePath: string;
  /** SHA-256 of the file bytes; null when the file does not exist */
  sha256: string | null;
}

export function digestJSONLContent(
  filePath: string,
  content: string | null
): JSONLFileDigest {
  return {
    filePath,
    sha256:
      content === null ? null : createHash("sha256").update(content, "utf8").digest("hex"),
  };
}

export function readJSONLFileDigest(filePath: string): JSONLFileDigest {
  return digestJSONLContent(
    filePath,
    fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null
  );
}

/**
 * True when the database last imported or exported exactly this file content.
 */
export function isJSONLSynced(
  db: Database.Database,
  digest: JSONLFileDigest
): boolean {
  const row = db
    .prepare("SELECT sha256 FROM jsonl_sync_state WHERE file_path = ?")
    .get(path.resolve(digest.filePath)) as
    | { sha256: string | null }
    | undefined;
  return row !== undefined && row.sha256 === digest.sha256;
}

/**
 * Record that the database now holds exactly the content of this file.
 */
export function recordJSONLSync(
  db: Database.Database,
  digest: JSONLFileDigest
): void {
  db.prepare(
    `INSERT INTO jsonl_sync_state (file_path, sha256, synced_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(file_path) DO UPDATE SET
       sha256 = excluded.sha256,
       synced_at = excluded.synced_at`
  ).run(path.resolve(digest.filePath), digest.sha256);
}

import type Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import {
  isJSONLSynced,
  readJSONLSnapshot,
  recordJSONLSync,
} from "./jsonl-sync-state.js";

export class TrackerPublicationError extends Error {
  constructor(
    readonly filePath: string,
    readonly field: string,
    message: string,
  ) {
    super(`${filePath}: ${field}: ${message}`);
    this.name = "TrackerPublicationError";
  }
}

function syncDirectory(directory: string) {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeDurably(filePath: string, content: string) {
  const descriptor = fs.openSync(filePath, "w");
  try {
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readJournal(journalPath: string) {
  const journal: unknown = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  if (!Array.isArray(journal) || journal.length !== 2) {
    throw new TrackerPublicationError(
      journalPath,
      "files",
      "expected two files",
    );
  }
  return journal.map((entry: unknown) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("filePath" in entry) ||
      typeof entry.filePath !== "string" ||
      !("previous" in entry) ||
      (entry.previous !== null && typeof entry.previous !== "string") ||
      !("next" in entry) ||
      typeof entry.next !== "string" ||
      path.dirname(entry.filePath) !== path.dirname(journalPath)
    ) {
      throw new TrackerPublicationError(
        journalPath,
        "files",
        "invalid publication entry",
      );
    }
    return {
      filePath: entry.filePath,
      previous: entry.previous,
      next: entry.next,
    };
  });
}

export function recoverPublication(
  database: Database.Database,
  directory: string,
) {
  const journalPath = path.resolve(directory, ".publication.json");
  if (!fs.existsSync(journalPath)) return;
  if (!database.inTransaction) {
    database
      .transaction(() => recoverPublication(database, directory))
      .immediate();
    return;
  }
  const journal = readJournal(journalPath);
  const committed = journal.every(({ filePath, next }) =>
    isJSONLSynced(database, {
      filePath,
      sha256: createHash("sha256").update(next).digest("hex"),
      entities: [],
    }),
  );
  for (const entry of journal) {
    const content = committed ? entry.next : entry.previous;
    if (content === null) {
      fs.rmSync(entry.filePath, { force: true });
    } else if (
      !fs.existsSync(entry.filePath) ||
      fs.readFileSync(entry.filePath, "utf8") !== content
    ) {
      writeDurably(`${entry.filePath}.publication`, content);
      fs.renameSync(`${entry.filePath}.publication`, entry.filePath);
    }
    fs.rmSync(`${entry.filePath}.publication`, { force: true });
  }
  syncDirectory(directory);
  fs.unlinkSync(journalPath);
  syncDirectory(directory);
}

export function publishJSONL(
  database: Database.Database,
  publications: { filePath: string; content: string }[],
) {
  const directory = path.dirname(publications[0].filePath);
  fs.mkdirSync(directory, { recursive: true });
  const journalPath = path.join(directory, ".publication.json");
  const journal = publications.map(({ filePath, content }) => ({
    filePath: path.resolve(filePath),
    previous: fs.existsSync(filePath)
      ? fs.readFileSync(filePath, "utf8")
      : null,
    next: content,
  }));
  writeDurably(`${journalPath}.tmp`, JSON.stringify(journal));
  fs.renameSync(`${journalPath}.tmp`, journalPath);
  syncDirectory(directory);
  for (const entry of journal) {
    if (entry.previous === entry.next) continue;
    writeDurably(`${entry.filePath}.publication`, entry.next);
    fs.renameSync(`${entry.filePath}.publication`, entry.filePath);
    syncDirectory(directory);
  }
  for (const entry of journal)
    recordJSONLSync(database, readJSONLSnapshot(entry.filePath));
}

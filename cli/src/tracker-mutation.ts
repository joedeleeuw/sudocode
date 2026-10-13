import type Database from "better-sqlite3";
import { importJSONLIfStale } from "./import.js";
import { exportToJSONL } from "./export.js";
import { recoverPublication } from "./tracker-publication.js";

export function persistMutation<Mutation>(
  database: Database.Database,
  directory: string,
  mutate: () => Mutation,
) {
  database.exec("BEGIN IMMEDIATE");
  try {
    recoverPublication(database, directory);
    importJSONLIfStale(database, directory);
    const mutation = mutate();
    if (mutation instanceof Promise)
      throw new TypeError("Tracker mutation must be synchronous");
    exportToJSONL(database, { outputDir: directory });
    database.exec("COMMIT");
    recoverPublication(database, directory);
    return mutation;
  } catch (error) {
    if (database.inTransaction) database.exec("ROLLBACK");
    recoverPublication(database, directory);
    throw error;
  }
}

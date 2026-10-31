import type Database from "better-sqlite3";
import {
  createAdr,
  deleteAdr,
  getAdr,
  listAdrs,
  updateAdr,
  type AdrWithState,
  type CreateAdrInput,
  type ListAdrsOptions,
  type UpdateAdrInput,
} from "@sudocode-ai/cli/dist/operations/adrs.js";

export function getAllAdrs(
  db: Database.Database,
  options: ListAdrsOptions = {}
): AdrWithState[] {
  return listAdrs(db, options);
}

export function getAdrById(
  db: Database.Database,
  id: string
): AdrWithState | null {
  return getAdr(db, id);
}

export function createNewAdr(
  db: Database.Database,
  input: CreateAdrInput
): AdrWithState {
  return createAdr(db, input);
}

export function updateExistingAdr(
  db: Database.Database,
  id: string,
  input: UpdateAdrInput
): AdrWithState {
  return updateAdr(db, id, input);
}

export function deleteExistingAdr(db: Database.Database, id: string): boolean {
  return deleteAdr(db, id);
}

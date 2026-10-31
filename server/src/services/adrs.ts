import type Database from "better-sqlite3";
import type { Adr } from "@sudocode-ai/types";
import {
  createAdr,
  deleteAdr,
  getAdr,
  isAdrSuperseded,
  listAdrs,
  updateAdr,
  type CreateAdrInput,
  type ListAdrsOptions,
  type UpdateAdrInput,
} from "@sudocode-ai/cli/dist/operations/adrs.js";

export type AdrWithState = Adr & { superseded: boolean };

function withState(db: Database.Database, adr: Adr): AdrWithState {
  return { ...adr, superseded: isAdrSuperseded(db, adr.id) };
}

export function getAllAdrs(
  db: Database.Database,
  options: ListAdrsOptions = {}
): AdrWithState[] {
  return listAdrs(db, options).map((adr) => withState(db, adr));
}

export function getAdrById(
  db: Database.Database,
  id: string
): AdrWithState | null {
  const adr = getAdr(db, id);
  return adr ? withState(db, adr) : null;
}

export function createNewAdr(
  db: Database.Database,
  input: CreateAdrInput
): AdrWithState {
  return withState(db, createAdr(db, input));
}

export function updateExistingAdr(
  db: Database.Database,
  id: string,
  input: UpdateAdrInput
): AdrWithState {
  return withState(db, updateAdr(db, id, input));
}

export function deleteExistingAdr(db: Database.Database, id: string): boolean {
  return deleteAdr(db, id);
}

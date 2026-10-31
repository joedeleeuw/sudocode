import type Database from "better-sqlite3";
import type { Adr, EntityType, Issue, Spec } from "@sudocode-ai/types";
import { getEntityRow } from "@sudocode-ai/types/entities";
import { getEntityTypeFromId } from "../id-generator.js";
import { getSpec, deleteSpec } from "./specs.js";
import { getIssue, deleteIssue } from "./issues.js";
import { getAdr, deleteAdr } from "./adrs.js";

export type Entity = Spec | Issue | Adr;

export function getEntity(
  db: Database.Database,
  id: string,
  entityType: EntityType
): Entity | null {
  switch (entityType) {
    case "spec":
      return getSpec(db, id);
    case "issue":
      return getIssue(db, id);
    case "adr":
      return getAdr(db, id);
  }
}

export function findEntity(
  db: Database.Database,
  id: string
): { entity: Entity; entityType: EntityType } | null {
  const entityType = getEntityTypeFromId(id);
  const entity = getEntity(db, id, entityType);
  return entity ? { entity, entityType } : null;
}

export function getEntityIdentity(
  db: Database.Database,
  id: string,
  entityType: EntityType
): { id: string; uuid: string } | null {
  const row = getEntityRow(entityType);
  const entity: unknown = db
    .prepare(`SELECT id, uuid FROM ${row.table} WHERE id = ?`)
    .get(id);
  if (entity === undefined) return null;
  if (typeof entity !== "object" || entity === null) {
    throw new Error(`Invalid ${row.label} identity row for ${id}`);
  }
  if (!("id" in entity) || !("uuid" in entity)) {
    throw new Error(`Invalid ${row.label} identity row for ${id}`);
  }
  if (typeof entity.id !== "string" || typeof entity.uuid !== "string") {
    throw new Error(`Invalid ${row.label} identity row for ${id}`);
  }
  return { id: entity.id, uuid: entity.uuid };
}

export function deleteEntity(
  db: Database.Database,
  id: string,
  entityType: EntityType
): boolean {
  switch (entityType) {
    case "spec":
      return deleteSpec(db, id);
    case "issue":
      return deleteIssue(db, id);
    case "adr":
      return deleteAdr(db, id);
  }
}

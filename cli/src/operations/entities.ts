import type Database from "better-sqlite3";
import type { EntityType } from "@sudocode-ai/types";
import {
  getEntityRow,
  getEntityTypeFromId,
  type Entity,
  type EntitySelection,
} from "@sudocode-ai/types/entities";
import { getSpec, deleteSpec } from "./specs.js";
import { getIssue, deleteIssue } from "./issues.js";
import { getAdr, deleteAdr } from "./adrs.js";

type EntityOperationCases = {
  [K in EntityType]: {
    get(db: Database.Database, id: string): Entity<K> | null;
    delete(db: Database.Database, id: string): boolean;
  };
};

const ENTITY_OPERATIONS = {
  spec: { get: getSpec, delete: deleteSpec },
  issue: { get: getIssue, delete: deleteIssue },
  adr: { get: getAdr, delete: deleteAdr },
} satisfies EntityOperationCases;

function getSelectedEntity<K extends EntityType>(
  db: Database.Database,
  id: string,
  operations: EntityOperationCases[K]
): Entity<K> | null {
  return operations.get(db, id);
}

export function getEntity<K extends EntityType>(
  db: Database.Database,
  id: string,
  entityType: K
): Entity<K> | null {
  return getSelectedEntity(db, id, ENTITY_OPERATIONS[entityType]);
}

function selectEntity<K extends EntityType>(
  entityType: K,
  entity: Entity<K>
): EntitySelection<K> {
  return { entity, entityType };
}

export function findEntity(
  db: Database.Database,
  id: string
): EntitySelection | null {
  const entityType = getEntityTypeFromId(id);
  const entity = getEntity(db, id, entityType);
  return entity ? selectEntity(entityType, entity) : null;
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

function deleteSelectedEntity<K extends EntityType>(
  db: Database.Database,
  id: string,
  operations: EntityOperationCases[K]
): boolean {
  return operations.delete(db, id);
}

export function deleteEntity(
  db: Database.Database,
  id: string,
  entityType: EntityType
): boolean {
  return deleteSelectedEntity(db, id, ENTITY_OPERATIONS[entityType]);
}

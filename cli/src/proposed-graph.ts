import type Database from "better-sqlite3";
import type { RelationshipJSONL } from "./types.js";
import {
  ENTITY_ROWS,
  getEntityTypeFromId,
  type EntitySnapshots,
} from "@sudocode-ai/types/entities";
import {
  addRelationship,
  EntityNotFoundError,
  listRelationships,
  removeRelationship,
  validateSupersessionEdges,
} from "./operations/relationships.js";
import { normalizeMirrorPath } from "./snapshot.js";

export interface ProposedRelationship {
  relationship: RelationshipJSONL;
  from_uuid: string;
  to_uuid: string;
}

export class ProposedGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposedGraphError";
  }
}

function entitySnapshotIds(snapshot: EntitySnapshots): Map<string, string> {
  const ids = new Map<string, string>();
  for (const row of ENTITY_ROWS) {
    for (const entity of snapshot[row.type]) {
      const key = `${row.type}:${entity.id}`;
      if (ids.has(key)) {
        throw new ProposedGraphError(`Duplicate ${row.type} ID ${entity.id} in proposed snapshot`);
      }
      ids.set(key, entity.uuid);
    }
  }
  return ids;
}

function failUnless(condition: boolean, message: string): void {
  if (!condition) throw new ProposedGraphError(message);
}

function proposedRelationships(snapshot: EntitySnapshots): ProposedRelationship[] {
  const ids = entitySnapshotIds(snapshot);
  const uuidSets = new Set<string>();
  for (const row of ENTITY_ROWS) {
    for (const entity of snapshot[row.type]) {
      failUnless(!uuidSets.has(entity.uuid), `Duplicate entity UUID ${entity.uuid}`);
      uuidSets.add(entity.uuid);
    }
  }
  const paths = new Map<string, string>();
  for (const row of ENTITY_ROWS) {
    if (row.type === "issue") continue;
    for (const entity of snapshot[row.type]) {
      const normalizedPath = normalizeMirrorPath(entity.file_path, row.type);
      const owner = paths.get(normalizedPath);
      failUnless(
        owner === undefined || owner === entity.uuid,
        `Markdown path ${normalizedPath} is owned by multiple UUIDs`
      );
      paths.set(normalizedPath, entity.uuid);
    }
  }
  const relationships: ProposedRelationship[] = [];
  const edgeKeys = new Set<string>();
  for (const row of ENTITY_ROWS) {
    for (const entity of snapshot[row.type]) {
      if ("parent_id" in entity && entity.parent_id !== undefined) {
        const parentUuid = ids.get(`${row.type}:${entity.parent_id}`);
        if (parentUuid === undefined) {
          throw new EntityNotFoundError(row.type, entity.parent_id);
        }
        failUnless(
          parentUuid !== entity.uuid,
          `${entity.id} cannot be its own parent`
        );
        if (entity.parent_uuid !== undefined) {
          failUnless(
            entity.parent_uuid === parentUuid,
            `Parent UUID ${entity.parent_uuid} for ${entity.id} does not match ${entity.parent_id} (${parentUuid})`
          );
        }
      }
      for (const relationship of entity.relationships) {
        failUnless(
          relationship.from === entity.id && relationship.from_type === row.type,
          `${entity.id} owns an invalid outgoing relationship from ${relationship.from}`
        );
        const fromUuid = ids.get(`${relationship.from_type}:${relationship.from}`);
        const toUuid = ids.get(`${relationship.to_type}:${relationship.to}`);
        if (fromUuid === undefined) {
          throw new EntityNotFoundError(relationship.from_type, relationship.from);
        }
        if (toUuid === undefined) {
          throw new EntityNotFoundError(relationship.to_type, relationship.to);
        }
        const key = edgeKey(relationship.type, fromUuid, toUuid);
        failUnless(!edgeKeys.has(key), `Duplicate ${relationship.type} edge ${relationship.from} -> ${relationship.to}`);
        edgeKeys.add(key);
        relationships.push({ relationship, from_uuid: fromUuid, to_uuid: toUuid });
      }
      for (const feedback of entity.feedback ?? []) {
        if (feedback.from_id !== undefined) {
          const fromType = getEntityTypeFromId(feedback.from_id);
          const fromUuid = ids.get(`${fromType}:${feedback.from_id}`);
          if (fromUuid === undefined) {
            throw new EntityNotFoundError(fromType, feedback.from_id);
          }
        }
        const targetType = getEntityTypeFromId(feedback.to_id);
        const targetUuid = ids.get(`${targetType}:${feedback.to_id}`);
        if (targetUuid === undefined) {
          throw new EntityNotFoundError(targetType, feedback.to_id);
        }
      }
    }
  }
  validateSupersessionEdges(
    relationships
      .filter((proposed) => proposed.relationship.type === "supersedes")
      .map((proposed) => ({
        from_id: proposed.relationship.from,
        from_uuid: proposed.from_uuid,
        from_type: proposed.relationship.from_type,
        to_id: proposed.relationship.to,
        to_uuid: proposed.to_uuid,
        to_type: proposed.relationship.to_type,
      }))
  );
  return relationships;
}

function edgeKey(type: string, fromUuid: string, toUuid: string): string {
  return `${type}:${fromUuid}:${toUuid}`;
}

export interface ProposedGraph {
  readonly relationships: readonly ProposedRelationship[];
}

export function validateProposedSnapshot(snapshot: EntitySnapshots): ProposedGraph {
  return { relationships: proposedRelationships(snapshot) };
}

export function applyProposedGraph(
  db: Database.Database,
  graph: ProposedGraph
): void {
  const proposedKeys = new Set(
    graph.relationships.map((edge) =>
      edgeKey(edge.relationship.type, edge.from_uuid, edge.to_uuid)
    )
  );
  const existing = listRelationships(db);
  const existingKeys = new Set(
    existing.map((edge) => edgeKey(edge.relationship_type, edge.from_uuid, edge.to_uuid))
  );
  for (const relationship of existing) {
    if (
      proposedKeys.has(
        edgeKey(relationship.relationship_type, relationship.from_uuid, relationship.to_uuid)
      )
    ) {
      continue;
    }
    removeRelationship(
      db,
      relationship.from_id,
      relationship.from_type,
      relationship.to_id,
      relationship.to_type,
      relationship.relationship_type
    );
  }
  for (const edge of graph.relationships) {
    if (existingKeys.has(edgeKey(edge.relationship.type, edge.from_uuid, edge.to_uuid))) continue;
    addRelationship(db, {
      from_id: edge.relationship.from,
      from_type: edge.relationship.from_type,
      to_id: edge.relationship.to,
      to_type: edge.relationship.to_type,
      relationship_type: edge.relationship.type,
    });
  }
}

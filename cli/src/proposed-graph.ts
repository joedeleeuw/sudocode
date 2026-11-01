import type Database from "better-sqlite3";
import type { RelationshipJSONL } from "./types.js";
import {
  ENTITY_ROWS,
  getEntityRow,
  getEntityTypeFromId,
  type EntitySnapshot,
  type EntitySnapshots,
  type EntityType,
} from "@sudocode-ai/types/entities";
import {
  deleteRelationshipRow,
  EntityNotFoundError,
  insertRelationshipRow,
  listRelationships,
  validateSupersessionEdges,
} from "./operations/relationships.js";
import { normalizeMirrorPath } from "./snapshot.js";
import type { ResolvedParent } from "./operations/parents.js";

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

type ProposedScope = Partial<EntitySnapshots>;

interface ScopedEntity {
  entityType: EntityType;
  entity: EntitySnapshot;
}

function scopedEntities(scope: ProposedScope): ScopedEntity[] {
  return ENTITY_ROWS.flatMap((row) => {
    const entities: readonly EntitySnapshot[] | undefined = scope[row.type];
    if (entities === undefined) return [];
    return entities.map((entity) => ({ entityType: row.type, entity }));
  });
}

function entitySnapshotIds(entities: readonly ScopedEntity[]): Map<string, string> {
  const ids = new Map<string, string>();
  for (const { entityType, entity } of entities) {
    const key = `${entityType}:${entity.id}`;
    if (ids.has(key)) {
      throw new ProposedGraphError(`Duplicate ${entityType} ID ${entity.id} in proposed snapshot`);
    }
    ids.set(key, entity.uuid);
  }
  return ids;
}

function failUnless(condition: boolean, message: string): void {
  if (!condition) throw new ProposedGraphError(message);
}

function proposedRelationships(scope: ProposedScope): ProposedRelationship[] {
  const entities = scopedEntities(scope);
  const ids = entitySnapshotIds(entities);
  const endpointUuid = (entityType: EntityType, id: string): string | null => {
    if (scope[entityType] === undefined) return null;
    const uuid = ids.get(`${entityType}:${id}`);
    if (uuid === undefined) throw new EntityNotFoundError(entityType, id);
    return uuid;
  };
  const uuidSets = new Set<string>();
  for (const { entity } of entities) {
    failUnless(!uuidSets.has(entity.uuid), `Duplicate entity UUID ${entity.uuid}`);
    uuidSets.add(entity.uuid);
  }
  const paths = new Map<string, string>();
  for (const { entityType, entity } of entities) {
    if (entityType === "issue" || !("file_path" in entity)) continue;
    const normalizedPath = normalizeMirrorPath(entity.file_path, entityType);
    const owner = paths.get(normalizedPath);
    failUnless(
      owner === undefined || owner === entity.uuid,
      `Markdown path ${normalizedPath} is owned by multiple UUIDs`
    );
    paths.set(normalizedPath, entity.uuid);
  }
  const relationships: ProposedRelationship[] = [];
  const edgeKeys = new Set<string>();
  for (const { entityType, entity } of entities) {
    if ("parent_id" in entity && entity.parent_id !== undefined) {
      const parentUuid = endpointUuid(entityType, entity.parent_id);
      failUnless(
        parentUuid !== entity.uuid,
        `${entity.id} cannot be its own parent`
      );
      if (entity.parent_uuid !== undefined) {
        failUnless(
          entity.parent_uuid === parentUuid,
          `${getEntityRow(entityType).jsonlFile}: ${entity.id} parent_uuid ${entity.parent_uuid} does not match parent_id ${entity.parent_id} (${parentUuid})`
        );
      }
    }
    for (const relationship of entity.relationships) {
      failUnless(
        relationship.from === entity.id && relationship.from_type === entityType,
        `${entity.id} owns an invalid outgoing relationship from ${relationship.from}`
      );
      const toUuid = endpointUuid(relationship.to_type, relationship.to);
      if (toUuid === null) continue;
      const key = edgeKey(relationship.type, entity.uuid, toUuid);
      failUnless(!edgeKeys.has(key), `Duplicate ${relationship.type} edge ${relationship.from} -> ${relationship.to}`);
      edgeKeys.add(key);
      relationships.push({ relationship, from_uuid: entity.uuid, to_uuid: toUuid });
    }
    for (const feedback of entity.feedback ?? []) {
      if (feedback.from_id !== undefined) {
        endpointUuid(getEntityTypeFromId(feedback.from_id), feedback.from_id);
      }
      endpointUuid(getEntityTypeFromId(feedback.to_id), feedback.to_id);
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

/** Each spec's and issue's resolved parent, keyed by the entity's UUID */
export type ParentMap = ReadonlyMap<string, ResolvedParent>;

export interface ProposedState {
  readonly snapshot: EntitySnapshots;
  readonly relationships: readonly ProposedRelationship[];
  readonly parents: ParentMap;
}

/**
 * Validate a complete proposed snapshot. Import applies it exactly as written:
 * statuses are stored, never derived, so the result depends only on the
 * snapshot. Each parent is resolved here into one value, a root or a parent
 * named by both id and uuid, and the snapshot carries exactly that value.
 */
export function validateProposedSnapshot(snapshot: EntitySnapshots): ProposedState {
  const relationships = proposedRelationships(snapshot);
  const parents = new Map<string, ResolvedParent>();
  return {
    snapshot: {
      spec: withResolvedParents(snapshot.spec, parents),
      issue: withResolvedParents(snapshot.issue, parents),
      adr: snapshot.adr,
    },
    relationships,
    parents,
  };
}

function withResolvedParents<T extends { uuid: string; id: string; parent_id?: string; parent_uuid?: string }>(
  entities: readonly T[],
  parents: Map<string, ResolvedParent>
): T[] {
  const uuids = new Map(entities.map((entity) => [entity.id, entity.uuid]));
  return entities.map((entity) => {
    let parent: ResolvedParent = null;
    if (entity.parent_id !== undefined) {
      const parentUuid = uuids.get(entity.parent_id);
      if (parentUuid === undefined) {
        throw new ProposedGraphError(`${entity.id} names a missing parent ${entity.parent_id}`);
      }
      parent = { id: entity.parent_id, uuid: parentUuid };
    }
    parents.set(entity.uuid, parent);
    return { ...entity, parent_id: parent?.id, parent_uuid: parent?.uuid };
  });
}

/**
 * The resolved parent of one snapshot entity. Every spec and issue of the
 * validated snapshot has one; a missing entry is a broken invariant.
 */
export function parentOf(parents: ParentMap, entity: { id: string; uuid: string }): ResolvedParent {
  const parent = parents.get(entity.uuid);
  if (parent === undefined) {
    throw new ProposedGraphError(`${entity.id} has no resolved parent in the validated snapshot`);
  }
  return parent;
}

/**
 * Validate the entities of one snapshot file, as the per-file git merge
 * driver sees them: identities, paths, parents, supersession and every
 * endpoint inside that file. Endpoints in other files are validated when the
 * whole snapshot is imported.
 */
export function validateProposedFile<K extends EntityType>(
  entityType: K,
  entities: EntitySnapshot<K>[]
): void {
  const scope: ProposedScope = {};
  scope[entityType] = entities;
  proposedRelationships(scope);
}

/**
 * Replace the cache's relationships with the proposed graph. Rows only: the
 * status effects of the graph are already part of the proposed snapshot.
 */
export function applyProposedGraph(
  db: Database.Database,
  graph: ProposedState
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
    deleteRelationshipRow(db, relationship);
  }
  for (const edge of graph.relationships) {
    if (existingKeys.has(edgeKey(edge.relationship.type, edge.from_uuid, edge.to_uuid))) continue;
    insertRelationshipRow(db, {
      from_id: edge.relationship.from,
      from_uuid: edge.from_uuid,
      from_type: edge.relationship.from_type,
      to_id: edge.relationship.to,
      to_uuid: edge.to_uuid,
      to_type: edge.relationship.to_type,
      relationship_type: edge.relationship.type,
    });
  }
}

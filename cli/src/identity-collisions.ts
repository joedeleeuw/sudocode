import * as path from "path";
import type {
  EntityType,
  FeedbackJSONL,
  RelationshipJSONL,
} from "./types.js";
import {
  ENTITY_ID_PATTERN_SOURCE,
  getEntityRow,
  getEntityTypeFromId,
} from "@sudocode-ai/types/entities";
import { generateCollisionEntityId } from "./id-generator.js";

export class IdentityResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityResolutionError";
  }
}

export interface IdentityClaim {
  entityType: EntityType;
  uuid: string;
  id: string;
  filePath?: string;
  createdAt: string;
  fixed: boolean;
}

export interface AssignedIdentity {
  id: string;
  filePath?: string;
}

export interface IdentityCollision {
  entityType: EntityType;
  uuid: string;
  oldId: string;
  newId: string;
  oldFilePath?: string;
  newFilePath?: string;
}

export interface IdentityAssignment {
  identities: Map<string, AssignedIdentity>;
  collisions: IdentityCollision[];
}

export interface ReservedIdentities {
  ids: Iterable<string>;
  filePaths: Iterable<string>;
}

function compareClaims(a: IdentityClaim, b: IdentityClaim): number {
  if (a.fixed !== b.fixed) return a.fixed ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.uuid.localeCompare(b.uuid);
}

function allocateId(claim: IdentityClaim, takenIds: ReadonlySet<string>): string {
  if (!takenIds.has(claim.id)) return claim.id;
  if (claim.fixed) {
    throw new IdentityResolutionError(
      `${getEntityRow(claim.entityType).label} ID ${claim.id} is held by more than one UUID in the cache; rebuild the cache from the snapshot, then retry`
    );
  }
  return generateCollisionEntityId(claim.entityType, claim.uuid, takenIds);
}

function allocateFilePath(
  claim: IdentityClaim,
  filePath: string,
  id: string,
  takenPaths: ReadonlySet<string>
): string {
  if (!takenPaths.has(filePath)) return filePath;
  if (claim.fixed) {
    throw new IdentityResolutionError(
      `Markdown path ${filePath} is held by more than one UUID in the cache; rebuild the cache from the snapshot, then retry`
    );
  }
  const directory = getEntityRow(claim.entityType).markdownDir;
  const extension = path.posix.extname(filePath) || ".md";
  for (let suffix = 0; suffix < 1000; suffix++) {
    const candidate = `${directory}/${id}${suffix === 0 ? "" : `-${suffix}`}${extension}`;
    if (!takenPaths.has(candidate)) return candidate;
  }
  throw new IdentityResolutionError(`No free Markdown path for ${id} under ${directory}/`);
}

export function assignIdentities(
  claims: readonly IdentityClaim[],
  reserved: ReservedIdentities
): IdentityAssignment {
  const takenIds = new Set(reserved.ids);
  const takenPaths = new Set(reserved.filePaths);
  const identities = new Map<string, AssignedIdentity>();
  const collisions: IdentityCollision[] = [];
  for (const claim of [...claims].sort(compareClaims)) {
    if (identities.has(claim.uuid)) {
      throw new IdentityResolutionError(
        `UUID ${claim.uuid} is claimed by more than one record; remove the duplicate line, then retry`
      );
    }
    const id = allocateId(claim, takenIds);
    takenIds.add(id);
    const filePath =
      claim.filePath === undefined
        ? undefined
        : allocateFilePath(claim, claim.filePath, id, takenPaths);
    if (filePath !== undefined) takenPaths.add(filePath);
    identities.set(claim.uuid, { id, filePath });
    if (id !== claim.id || filePath !== claim.filePath) {
      collisions.push({
        entityType: claim.entityType,
        uuid: claim.uuid,
        oldId: claim.id,
        newId: id,
        oldFilePath: claim.filePath,
        newFilePath: filePath,
      });
    }
  }
  return { identities, collisions };
}

export interface NamespaceRecord {
  entityType: EntityType;
  id: string;
  uuid: string;
}

export interface ReferenceNamespace {
  readonly scope: ReadonlySet<EntityType>;
  readonly complete: boolean;
  readonly uuidsById: ReadonlyMap<string, ReadonlySet<string>>;
}

function namespaceKey(entityType: EntityType, id: string): string {
  return `${entityType}:${id}`;
}

export function createReferenceNamespace(
  scope: Iterable<EntityType>,
  complete: boolean,
  records: Iterable<NamespaceRecord>
): ReferenceNamespace {
  const uuidsById = new Map<string, Set<string>>();
  for (const record of records) {
    const key = namespaceKey(record.entityType, record.id);
    const owners = uuidsById.get(key) ?? new Set<string>();
    owners.add(record.uuid);
    uuidsById.set(key, owners);
  }
  return { scope: new Set(scope), complete, uuidsById };
}

interface ReferenceContext {
  namespace: ReferenceNamespace;
  identities: ReadonlyMap<string, AssignedIdentity>;
  owner: NamespaceRecord;
}

function resolveReference(
  context: ReferenceContext,
  targetType: EntityType,
  targetId: string,
  field: string,
  structural: boolean
): string {
  const { namespace, identities, owner } = context;
  const ownerRow = getEntityRow(owner.entityType);
  const ownerLabel = `${ownerRow.jsonlFile}: ${ownerRow.label} ${owner.id} (${owner.uuid}) ${field}`;
  if (targetType === owner.entityType && targetId === owner.id) {
    return identities.get(owner.uuid)?.id ?? targetId;
  }
  if (!namespace.scope.has(targetType)) return targetId;
  const uuids = namespace.uuidsById.get(namespaceKey(targetType, targetId));
  if (uuids === undefined) {
    if (structural && namespace.complete) {
      throw new IdentityResolutionError(
        `${ownerLabel} names ${targetId}, which is not in the snapshot; restore ${targetId} or remove the reference, then retry`
      );
    }
    return targetId;
  }
  if (uuids.size > 1) {
    throw new IdentityResolutionError(
      `${ownerLabel} names ${targetId}, which is ambiguous across UUIDs ${Array.from(uuids).sort().join(", ")}; edit the reference to name one entity, then retry`
    );
  }
  const [uuid] = uuids;
  return identities.get(uuid)?.id ?? targetId;
}

function remapRelationship(
  context: ReferenceContext,
  relationship: RelationshipJSONL,
  index: number
): RelationshipJSONL {
  return {
    ...relationship,
    from: resolveReference(
      context,
      relationship.from_type,
      relationship.from,
      `relationships[${index}].from`,
      true
    ),
    to: resolveReference(
      context,
      relationship.to_type,
      relationship.to,
      `relationships[${index}].to`,
      true
    ),
  };
}

function remapFeedback(
  context: ReferenceContext,
  feedback: FeedbackJSONL
): FeedbackJSONL {
  const field = `feedback.${feedback.id}`;
  return {
    ...feedback,
    from_id:
      feedback.from_id === undefined
        ? undefined
        : resolveReference(
            context,
            getEntityTypeFromId(feedback.from_id),
            feedback.from_id,
            `${field}.from_id`,
            true
          ),
    to_id: resolveReference(
      context,
      getEntityTypeFromId(feedback.to_id),
      feedback.to_id,
      `${field}.to_id`,
      true
    ),
  };
}

const MENTION_PATTERN = new RegExp(`(\\[\\[@?)(${ENTITY_ID_PATTERN_SOURCE})(?=[\\]|])`, "g");

function remapMentions(context: ReferenceContext, content: string): string {
  return content.replace(MENTION_PATTERN, (_match, opening: string, id: string) =>
    `${opening}${resolveReference(context, getEntityTypeFromId(id), id, "content", false)}`
  );
}

export interface ReferenceFields {
  id: string;
  uuid: string;
  content: string;
  file_path?: string;
  parent_id?: string;
  relationships: RelationshipJSONL[];
  feedback?: FeedbackJSONL[];
}

export function remapEntityReferences<T extends ReferenceFields>(
  entityType: EntityType,
  entity: T,
  namespace: ReferenceNamespace,
  identities: ReadonlyMap<string, AssignedIdentity>
): T {
  const context: ReferenceContext = {
    namespace,
    identities,
    owner: { entityType, id: entity.id, uuid: entity.uuid },
  };
  const assigned = identities.get(entity.uuid);
  if (assigned === undefined) {
    throw new IdentityResolutionError(
      `${getEntityRow(entityType).label} ${entity.id} (${entity.uuid}) has no assigned identity`
    );
  }
  return {
    ...entity,
    id: assigned.id,
    ...(assigned.filePath === undefined ? {} : { file_path: assigned.filePath }),
    ...(entity.parent_id === undefined
      ? {}
      : {
          parent_id: resolveReference(context, entityType, entity.parent_id, "parent_id", true),
        }),
    content: remapMentions(context, entity.content),
    relationships: entity.relationships.map((relationship, index) =>
      remapRelationship(context, relationship, index)
    ),
    ...(entity.feedback === undefined
      ? {}
      : { feedback: entity.feedback.map((feedback) => remapFeedback(context, feedback)) }),
  };
}

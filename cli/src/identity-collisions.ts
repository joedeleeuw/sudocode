import * as path from "path";
import type { FeedbackJSONL, RelationshipJSONL } from "./types.js";
import type { EntityType } from "@sudocode-ai/types";
import {
  getEntityRow,
  getEntityTypeFromId,
} from "@sudocode-ai/types/entities";
import { generateCollisionEntityId } from "./id-generator.js";

export interface IdentityRecord {
  id: string;
  uuid: string;
  title?: string;
  file_path?: string;
  content?: string;
  created_at: string;
  updated_at?: string;
  parent_id?: string;
  relationships?: RelationshipJSONL[];
  feedback?: FeedbackJSONL[];
}

export interface IdentityRename {
  entityType: EntityType;
  oldId: string;
  newId: string;
  uuid: string;
  oldFilePath?: string;
  newFilePath?: string;
}

export interface IdentityCollision {
  entityType: EntityType;
  uuid: string;
  oldId: string;
  newId: string;
  localTitle?: string;
  incomingTitle?: string;
  localCreatedAt?: string;
  incomingCreatedAt?: string;
  reason: string;
}

export interface IdentityResolution<T extends IdentityRecord> {
  entities: T[];
  renames: IdentityRename[];
  collisions: IdentityCollision[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueMirrorPath(
  entityType: EntityType,
  id: string,
  takenPaths: Set<string>,
  preferredPath?: string
): string | undefined {
  if (entityType === "issue") return undefined;
  if (preferredPath && !takenPaths.has(preferredPath)) return preferredPath;
  const row = getEntityRow(entityType);
  const extension = preferredPath ? path.posix.extname(preferredPath) || ".md" : ".md";
  for (let suffix = 0; suffix < 1000; suffix++) {
    const candidate = `${row.markdownDir}/${id}${suffix === 0 ? "" : `-${suffix}`}${extension}`;
    if (!takenPaths.has(candidate)) return candidate;
  }
  throw new Error(`Failed to allocate a unique Markdown path for ${id}`);
}

function replaceMention(content: string, oldId: string, newId: string): string {
  const mention = new RegExp(`(\\[\\[)${escapeRegExp(oldId)}(?=[\\]|])`, "g");
  return content.replace(mention, `$1${newId}`);
}

function remapRelationship(
  relationship: RelationshipJSONL,
  rename: IdentityRename,
  entityUuid: string
): RelationshipJSONL {
  let from = relationship.from;
  let to = relationship.to;
  if (
    relationship.from_type === rename.entityType &&
    from === rename.oldId &&
    entityUuid === rename.uuid
  ) {
    from = rename.newId;
  }
  return from === relationship.from && to === relationship.to
    ? relationship
    : { ...relationship, from, to };
}

function remapFeedback(
  feedback: FeedbackJSONL,
  rename: IdentityRename,
  entityUuid: string
): FeedbackJSONL {
  let from_id = feedback.from_id;
  let to_id = feedback.to_id;
  if (
    rename.entityType === "issue" &&
    from_id === rename.oldId &&
    entityUuid === rename.uuid
  ) {
    from_id = rename.newId;
  }
  if (
    to_id === rename.oldId &&
    entityUuid === rename.uuid
  ) {
    to_id = rename.newId;
  }
  return from_id === feedback.from_id && to_id === feedback.to_id
    ? feedback
    : { ...feedback, from_id, to_id };
}

export function remapIdentityReferences<T extends IdentityRecord>(
  entities: T[],
  renames: IdentityRename[]
): T[] {
  if (renames.length === 0) return entities;
  return entities.map((entity) => {
    let next = entity;
    for (const rename of renames) {
      const content = next.content && next.uuid === rename.uuid
        ? replaceMention(next.content, rename.oldId, rename.newId)
        : next.content;
      const parent_id = next.parent_id;
      const relationships = next.relationships?.map((relationship) =>
        remapRelationship(relationship, rename, next.uuid)
      );
      const feedback = next.feedback?.map((entry) =>
        remapFeedback(entry, rename, next.uuid)
      );
      if (
        content !== next.content ||
        parent_id !== next.parent_id ||
        relationships !== next.relationships ||
        feedback !== next.feedback
      ) {
        next = { ...next, content, parent_id, relationships, feedback };
      }
    }
    return next;
  });
}

export function resolveIdentityCollisions<T extends IdentityRecord>(
  entities: T[],
  existing: IdentityRecord[] = []
): IdentityResolution<T> {
  if (entities.length === 0 && existing.length === 0) {
    return { entities, renames: [], collisions: [] };
  }
  const first = entities[0] ?? existing[0];
  const entityType = getEntityTypeFromId(first.id);
  const takenIds = new Set(existing.map((entity) => entity.id));
  const takenPaths = new Set(
    existing
      .map((entity) => entity.file_path)
      .filter((filePath) => filePath !== undefined)
  );
  const allocatedPaths = new Set<string>();
  const existingPathOwners = new Map(
    existing.flatMap((entity) =>
      entity.file_path === undefined ? [] : [[entity.file_path, entity.uuid]]
    )
  );
  const existingById = new Map(existing.map((entity) => [entity.id, entity]));
  const renames: IdentityRename[] = [];
  const collisions: IdentityCollision[] = [];
  const resolved = entities.map((entity) => {
    if (getEntityTypeFromId(entity.id) !== entityType) {
      throw new Error(`Mixed entity types in identity resolution for ${entity.id}`);
    }
    const local = existingById.get(entity.id);
    const shouldRenameId = local
      ? local.uuid !== entity.uuid
      : takenIds.has(entity.id);
    const next = { ...entity };
    if (shouldRenameId) {
      const rename: IdentityRename = {
        entityType,
        oldId: entity.id,
        newId: generateCollisionEntityId(entityType, entity.uuid, takenIds),
        uuid: entity.uuid,
        oldFilePath: entity.file_path,
      };
      next.id = rename.newId;
      takenIds.add(rename.newId);
      renames.push(rename);
      collisions.push({
        entityType,
        uuid: entity.uuid,
        oldId: rename.oldId,
        newId: rename.newId,
        localTitle: local?.title,
        incomingTitle: entity.title,
        localCreatedAt: local && "created_at" in local && typeof local.created_at === "string" ? local.created_at : undefined,
        incomingCreatedAt: "created_at" in entity && typeof entity.created_at === "string" ? entity.created_at : "",
        reason: local ? "Same ID but different UUID" : "Duplicate ID",
      });
    } else {
      takenIds.add(entity.id);
    }
    if (entityType !== "issue") {
      const rename = renameForUuid(renames, next.uuid);
      const existingPathOwner = next.file_path
        ? existingPathOwners.get(next.file_path)
        : undefined;
      const pathTakenByAnotherExisting = existingPathOwner !== undefined && existingPathOwner !== next.uuid;
      const pathTakenByIncoming = next.file_path !== undefined && allocatedPaths.has(next.file_path);
      if (
        rename !== undefined ||
        next.file_path === undefined ||
        pathTakenByAnotherExisting ||
        pathTakenByIncoming
      ) {
        const newFilePath = uniqueMirrorPath(entityType, next.id, takenPaths, next.file_path);
        if (newFilePath === undefined) {
          throw new Error(`Failed to allocate a Markdown path for ${next.id}`);
        }
        if (rename) rename.newFilePath = newFilePath;
        next.file_path = newFilePath;
        takenPaths.add(newFilePath);
        allocatedPaths.add(newFilePath);
      } else if (next.file_path !== undefined) {
        takenPaths.add(next.file_path);
        allocatedPaths.add(next.file_path);
      }
    }
    return next;
  });
  return {
    entities: remapIdentityReferences(resolved, renames),
    renames,
    collisions,
  };
}

function renameForUuid(
  renames: IdentityRename[],
  uuid: string
): IdentityRename | undefined {
  return renames.find((rename) => rename.uuid === uuid);
}

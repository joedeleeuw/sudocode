/**
 * Operations for Relationships
 */

import type Database from "better-sqlite3";
import type { Relationship, EntityType, IssueStatus, RelationshipType } from "../types.js";
import { isValidRelationshipType, getValidRelationshipTypes } from "../validation.js";
import { getEntityRow } from "@sudocode-ai/types/entities";
import { getIssue } from "./issues.js";
import { getEntityIdentity } from "./entities.js";

export class InvalidRelationshipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRelationshipError";
  }
}

export class EntityNotFoundError extends Error {
  constructor(entityType: EntityType, id: string) {
    super(`${getEntityRow(entityType).label} not found: ${id}`);
    this.name = "EntityNotFoundError";
  }
}

export class RelationshipExistsError extends Error {
  constructor(input: CreateRelationshipInput) {
    super(`Relationship already exists: ${input.from_id} (${input.from_type}) --[${input.relationship_type}]--> ${input.to_id} (${input.to_type})`);
    this.name = "RelationshipExistsError";
  }
}

export interface CreateRelationshipInput {
  from_id: string;
  from_type: EntityType;
  to_id: string;
  to_type: EntityType;
  relationship_type: RelationshipType;
  metadata?: string;
}

export interface SupersessionEdge {
  from_id: string;
  from_uuid: string;
  from_type: EntityType;
  to_id: string;
  to_uuid: string;
  to_type: EntityType;
}

export function validateSupersessionEdges(edges: SupersessionEdge[]): void {
  const adjacency = new Map<string, SupersessionEdge[]>();
  for (const edge of edges) {
    if (edge.from_type !== "adr" || edge.to_type !== "adr") {
      throw new InvalidRelationshipError(
        `supersedes requires an ADR source and target; received ${edge.from_type} -> ${edge.to_type}`
      );
    }
    if (edge.from_uuid === edge.to_uuid) {
      throw new InvalidRelationshipError(
        `ADR ${edge.from_id} cannot supersede itself`
      );
    }
    const outgoing = adjacency.get(edge.from_uuid) ?? [];
    outgoing.push(edge);
    adjacency.set(edge.from_uuid, outgoing);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (uuid: string, lastEdge?: SupersessionEdge): void => {
    if (visited.has(uuid)) return;
    if (visiting.has(uuid)) {
      throw new InvalidRelationshipError(
        lastEdge
          ? `supersedes ${lastEdge.from_id} -> ${lastEdge.to_id} would create a cycle`
          : `supersedes graph contains a cycle at ${uuid}`
      );
    }
    visiting.add(uuid);
    for (const edge of adjacency.get(uuid) ?? []) {
      visit(edge.to_uuid, edge);
    }
    visiting.delete(uuid);
    visited.add(uuid);
  };
  for (const uuid of adjacency.keys()) visit(uuid);
}

type RelationshipEndpoints = Pick<
  CreateRelationshipInput,
  "from_id" | "from_type" | "to_id" | "to_type" | "relationship_type"
>;

export type RelationshipRow = Omit<Relationship, "created_at">;

const BLOCKED_ENDPOINT: Partial<Record<RelationshipType, "from" | "to">> = {
  blocks: "to",
  "depends-on": "from",
};

/**
 * The blocked and blocking issue of an issue-to-issue `blocks` or
 * `depends-on` edge, or null when the edge has no status effect.
 */
export function blockingPair(
  edge: RelationshipEndpoints
): { blockedId: string; blockerId: string } | null {
  const blocked = BLOCKED_ENDPOINT[edge.relationship_type];
  if (blocked === undefined || edge.from_type !== "issue" || edge.to_type !== "issue") {
    return null;
  }
  return blocked === "to"
    ? { blockedId: edge.to_id, blockerId: edge.from_id }
    : { blockedId: edge.from_id, blockerId: edge.to_id };
}

/**
 * Status an issue takes from one of its blockers: an open or in-progress
 * issue with a blocker that is not closed is blocked.
 */
export function statusWithBlocker(
  blockedStatus: IssueStatus,
  blockerStatus: IssueStatus
): IssueStatus {
  return blockerStatus !== "closed" &&
    (blockedStatus === "open" || blockedStatus === "in_progress")
    ? "blocked"
    : blockedStatus;
}

/**
 * Insert one relationship row. No validation and no status effects.
 */
export function insertRelationshipRow(db: Database.Database, row: RelationshipRow): void {
  db.prepare(`
    INSERT INTO relationships (
      from_id, from_uuid, from_type, to_id, to_uuid, to_type, relationship_type, metadata
    ) VALUES (
      @from_id, @from_uuid, @from_type, @to_id, @to_uuid, @to_type, @relationship_type, @metadata
    )
  `).run({ ...row, metadata: row.metadata ?? null });
}

/**
 * Delete one relationship row. No status effects.
 */
export function deleteRelationshipRow(db: Database.Database, edge: RelationshipEndpoints): boolean {
  const result = db.prepare(`
    DELETE FROM relationships
    WHERE from_id = ? AND from_type = ?
      AND to_id = ? AND to_type = ?
      AND relationship_type = ?
  `).run(edge.from_id, edge.from_type, edge.to_id, edge.to_type, edge.relationship_type);
  return result.changes > 0;
}

function validateSupersession(
  db: Database.Database,
  input: CreateRelationshipInput,
  fromEntity: { id: string; uuid: string },
  toEntity: { id: string; uuid: string }
): void {
  if (input.relationship_type !== "supersedes") return;
  const existing = listRelationships(db).filter(
    (relationship) => relationship.relationship_type === "supersedes"
  );
  validateSupersessionEdges([
    ...existing,
    {
      from_id: input.from_id,
      from_uuid: fromEntity.uuid,
      from_type: input.from_type,
      to_id: input.to_id,
      to_uuid: toEntity.uuid,
      to_type: input.to_type,
    },
  ]);
}

/**
 * Add a validated relationship row without status effects. Markdown ingestion
 * records the edges a file declares exactly as written; the blocked status
 * that a `blocks` or `depends-on` edge implies is applied only by the explicit
 * relationship command (addRelationship).
 */
export function addRelationshipRow(
  db: Database.Database,
  input: CreateRelationshipInput
): Relationship {
  if (!isValidRelationshipType(input.relationship_type)) {
    throw new Error(
      `Invalid relationship type: ${input.relationship_type}. Valid types: ${getValidRelationshipTypes().join(", ")}`
    );
  }

  const fromEntity = getEntityIdentity(db, input.from_id, input.from_type);
  if (!fromEntity) {
    throw new EntityNotFoundError(input.from_type, input.from_id);
  }

  const toEntity = getEntityIdentity(db, input.to_id, input.to_type);
  if (!toEntity) {
    throw new EntityNotFoundError(input.to_type, input.to_id);
  }

  validateSupersession(db, input, fromEntity, toEntity);

  const existing = getRelationship(
    db,
    input.from_id,
    input.from_type,
    input.to_id,
    input.to_type,
    input.relationship_type
  );
  if (existing) {
    return existing;
  }

  try {
    insertRelationshipRow(db, {
      from_id: input.from_id,
      from_uuid: fromEntity.uuid,
      from_type: input.from_type,
      to_id: input.to_id,
      to_uuid: toEntity.uuid,
      to_type: input.to_type,
      relationship_type: input.relationship_type,
      metadata: input.metadata,
    });
  } catch (error: any) {
    if (error.code && error.code.startsWith("SQLITE_CONSTRAINT")) {
      throw new RelationshipExistsError(input);
    }
    throw error;
  }

  const rel = getRelationship(
    db,
    input.from_id,
    input.from_type,
    input.to_id,
    input.to_type,
    input.relationship_type
  );
  if (!rel) {
    throw new Error("Failed to create relationship");
  }
  return rel;
}

/**
 * Add a relationship between entities, then mark the blocked issue blocked
 * when a new `blocks` or `depends-on` edge has an open blocker
 */
export function addRelationship(
  db: Database.Database,
  input: CreateRelationshipInput
): Relationship {
  const existed = getRelationship(
    db,
    input.from_id,
    input.from_type,
    input.to_id,
    input.to_type,
    input.relationship_type
  );
  const rel = addRelationshipRow(db, input);
  const pair = existed ? null : blockingPair(input);
  if (pair) {
    autoUpdateBlockedStatusOnAdd(db, pair.blockedId, pair.blockerId);
  }
  return rel;
}

/**
 * Auto-update blocked status when adding a 'blocks' or 'depends-on' relationship
 * Semantics:
 *   - blocks: blocker blocks blocked (blocker is the issue doing the blocking)
 *   - depends-on: blocked depends on blocker (blocked needs blocker to be done)
 */
function autoUpdateBlockedStatusOnAdd(
  db: Database.Database,
  blockedIssueId: string,
  blockerIssueId: string
): void {
  const blockerIssue = getIssue(db, blockerIssueId);
  const blockedIssue = getIssue(db, blockedIssueId);
  if (!blockerIssue || !blockedIssue) return;
  if (statusWithBlocker(blockedIssue.status, blockerIssue.status) === blockedIssue.status) return;
  db.prepare(`
    UPDATE issues
    SET status = 'blocked', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(blockedIssueId);
}

/**
 * Get a specific relationship
 */
export function getRelationship(
  db: Database.Database,
  from_id: string,
  from_type: EntityType,
  to_id: string,
  to_type: EntityType,
  relationship_type: RelationshipType
): Relationship | null {
  const stmt = db.prepare(`
    SELECT * FROM relationships
    WHERE from_id = ? AND from_type = ?
      AND to_id = ? AND to_type = ?
      AND relationship_type = ?
  `);

  return (
    (stmt.get(from_id, from_type, to_id, to_type, relationship_type) as
      | Relationship
      | undefined) ?? null
  );
}

/**
 * Remove a relationship
 */
export function removeRelationship(
  db: Database.Database,
  from_id: string,
  from_type: EntityType,
  to_id: string,
  to_type: EntityType,
  relationship_type: RelationshipType
): boolean {
  const edge = { from_id, from_type, to_id, to_type, relationship_type };
  const removed = deleteRelationshipRow(db, edge);
  const pair = blockingPair(edge);
  if (removed && pair) {
    autoUpdateBlockedStatusOnRemove(db, pair.blockedId);
  }
  return removed;
}

/**
 * Auto-update blocked status when removing a 'blocks' relationship
 */
function autoUpdateBlockedStatusOnRemove(
  db: Database.Database,
  blockedIssueId: string
): void {
  const blockedIssue = getIssue(db, blockedIssueId);

  // Only unblock if currently blocked
  if (blockedIssue && blockedIssue.status === "blocked") {
    // Check if there are any other open blockers
    const hasOtherBlockers = hasOpenBlockers(db, blockedIssueId);

    // If no other blockers, unblock the issue
    if (!hasOtherBlockers) {
      const updateStmt = db.prepare(`
        UPDATE issues
        SET status = 'open', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      updateStmt.run(blockedIssueId);
    }
  }
}

/**
 * Check if an issue has any open blockers
 * Semantics:
 *   - blocks: blocker --[blocks]--> issueId (incoming blocks)
 *   - depends-on: issueId --[depends-on]--> blocker (outgoing depends-on)
 */
function hasOpenBlockers(db: Database.Database, issueId: string): boolean {
  const stmt = db.prepare(`
    SELECT COUNT(*) as count
    FROM relationships r
    JOIN issues blocker ON (
      (r.relationship_type = 'blocks' AND r.from_id = blocker.id AND r.from_type = 'issue') OR
      (r.relationship_type = 'depends-on' AND r.to_id = blocker.id AND r.to_type = 'issue')
    )
    WHERE (
      (r.relationship_type = 'blocks' AND r.to_id = ? AND r.to_type = 'issue') OR
      (r.relationship_type = 'depends-on' AND r.from_id = ? AND r.from_type = 'issue')
    )
      AND blocker.status IN ('open', 'in_progress', 'blocked')
  `);

  const result = stmt.get(issueId, issueId) as { count: number };
  return result.count > 0;
}

/**
 * Get all outgoing relationships from an entity
 */
export function getOutgoingRelationships(
  db: Database.Database,
  entity_id: string,
  entity_type: EntityType,
  relationship_type?: RelationshipType
): Relationship[] {
  let query = `
    SELECT * FROM relationships
    WHERE from_id = @entity_id AND from_type = @entity_type
  `;

  const params: Record<string, any> = {
    entity_id,
    entity_type,
  };

  if (relationship_type !== undefined) {
    query += " AND relationship_type = @relationship_type";
    params.relationship_type = relationship_type;
  }

  // Deterministic ordering: by created_at DESC, then by to_id and relationship_type
  // This prevents oscillation when multiple relationships have the same timestamp
  query += " ORDER BY created_at DESC, to_id ASC, relationship_type ASC";

  const stmt = db.prepare(query);
  return stmt.all(params) as Relationship[];
}

/**
 * Get all incoming relationships to an entity
 */
export function getIncomingRelationships(
  db: Database.Database,
  entity_id: string,
  entity_type: EntityType,
  relationship_type?: RelationshipType
): Relationship[] {
  let query = `
    SELECT * FROM relationships
    WHERE to_id = @entity_id AND to_type = @entity_type
  `;

  const params: Record<string, any> = {
    entity_id,
    entity_type,
  };

  if (relationship_type !== undefined) {
    query += " AND relationship_type = @relationship_type";
    params.relationship_type = relationship_type;
  }

  // Deterministic ordering: by created_at DESC, then by from_id and relationship_type
  // This prevents oscillation when multiple relationships have the same timestamp
  query += " ORDER BY created_at DESC, from_id ASC, relationship_type ASC";

  const stmt = db.prepare(query);
  return stmt.all(params) as Relationship[];
}

/**
 * Get all dependencies (what this entity depends on - things that block it)
 */
export function getDependencies(
  db: Database.Database,
  entity_id: string,
  entity_type: EntityType
): Relationship[] {
  return getOutgoingRelationships(db, entity_id, entity_type, "blocks");
}

/**
 * Get all dependents (what depends on this entity - things it blocks)
 */
export function getDependents(
  db: Database.Database,
  entity_id: string,
  entity_type: EntityType
): Relationship[] {
  return getIncomingRelationships(db, entity_id, entity_type, "blocks");
}

/**
 * Get all relationships for an entity (both incoming and outgoing)
 */
export function getAllRelationships(
  db: Database.Database,
  entity_id: string,
  entity_type: EntityType
): { outgoing: Relationship[]; incoming: Relationship[] } {
  return {
    outgoing: getOutgoingRelationships(db, entity_id, entity_type),
    incoming: getIncomingRelationships(db, entity_id, entity_type),
  };
}

/**
 * List every relationship in the database
 */
export function listRelationships(db: Database.Database): Relationship[] {
  const stmt = db.prepare(`
    SELECT * FROM relationships
    ORDER BY created_at DESC, from_id ASC, to_id ASC, relationship_type ASC
  `);
  return stmt.all() as Relationship[];
}

/**
 * Check if a relationship exists
 */
export function relationshipExists(
  db: Database.Database,
  from_id: string,
  from_type: EntityType,
  to_id: string,
  to_type: EntityType,
  relationship_type: RelationshipType
): boolean {
  const rel = getRelationship(
    db,
    from_id,
    from_type,
    to_id,
    to_type,
    relationship_type
  );
  return rel !== null;
}

/**
 * Remove all relationships for an entity (both incoming and outgoing)
 * Use this when deleting an entity
 */
export function removeAllRelationships(
  db: Database.Database,
  entity_id: string,
  entity_type: EntityType
): number {
  const stmt = db.prepare(`
    DELETE FROM relationships
    WHERE (from_id = ? AND from_type = ?)
       OR (to_id = ? AND to_type = ?)
  `);

  const result = stmt.run(entity_id, entity_type, entity_id, entity_type);
  return result.changes;
}

/**
 * Remove only outgoing relationships for an entity
 * Use this when updating an entity to preserve incoming relationships
 * (e.g., preserves "implements" relationships from issues when updating a spec)
 */
export function removeOutgoingRelationships(
  db: Database.Database,
  entity_id: string,
  entity_type: EntityType
): number {
  const stmt = db.prepare(`
    DELETE FROM relationships
    WHERE from_id = ? AND from_type = ?
  `);

  const result = stmt.run(entity_id, entity_type);
  return result.changes;
}

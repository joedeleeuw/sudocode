/**
 * The parent of a spec or issue, resolved once at the boundary that receives
 * it: a root (null), or a child whose parent is named by both id and uuid.
 * Row writers store it as given; they never look a parent up themselves.
 */

import type Database from "better-sqlite3";

export type ResolvedParent = { readonly id: string; readonly uuid: string } | null;

export type ParentEntityType = "spec" | "issue";

const PARENT_TABLES = {
  spec: "specs",
  issue: "issues",
} as const satisfies Record<ParentEntityType, string>;

/**
 * Resolve a parent ID supplied by a command, route or markdown frontmatter.
 * A missing or empty ID is a root; an ID that names no entity fails.
 */
export function resolveParentId(
  db: Database.Database,
  entityType: ParentEntityType,
  parentId: string | null | undefined
): ResolvedParent {
  if (!parentId) return null;
  const parent = db
    .prepare(`SELECT id, uuid FROM ${PARENT_TABLES[entityType]} WHERE id = ?`)
    .get(parentId) as { id: string; uuid: string } | undefined;
  if (!parent) {
    throw new Error(
      `Parent ${entityType} not found: ${parentId}`
    );
  }
  return { id: parent.id, uuid: parent.uuid };
}

/**
 * The two parent columns of a row, written together from one resolved parent.
 */
export function parentColumns(parent: ResolvedParent): {
  parent_id: string | null;
  parent_uuid: string | null;
} {
  return { parent_id: parent?.id ?? null, parent_uuid: parent?.uuid ?? null };
}

/**
 * The SET clauses and parameters that move a row to `parent`, or none when the
 * row already holds it. Both columns change together or not at all.
 */
export function parentUpdate(
  existing: { parent_id?: string | null; parent_uuid?: string | null },
  parent: ResolvedParent
): { clauses: string[]; params: ReturnType<typeof parentColumns> } | null {
  const next = parentColumns(parent);
  if (
    next.parent_id === (existing.parent_id ?? null) &&
    next.parent_uuid === (existing.parent_uuid ?? null)
  ) {
    return null;
  }
  return {
    clauses: ["parent_id = @parent_id", "parent_uuid = @parent_uuid"],
    params: next,
  };
}

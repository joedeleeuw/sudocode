/**
 * JSONL merge conflict resolution
 *
 * Resolves git merge conflicts in issues.jsonl and specs.jsonl using:
 * - UUID-based deduplication
 * - Timestamp-based prioritization
 * - Metadata merging (relationships, tags)
 */

import * as fs from "fs";
import type { JSONLEntity } from "./jsonl.js";
import { toYaml, fromYaml } from "./yaml-converter.js";
import { mergeYamlContent } from "./git-merge.js";
import type { EntityType } from "@sudocode-ai/types";
import { getEntityTypeFromId } from "@sudocode-ai/types/entities";
import {
  assignIdentities,
  createReferenceNamespace,
  remapEntityReferences,
  IdentityResolutionError,
  type IdentityAssignment,
  type IdentityClaim,
  type ReferenceNamespace,
} from "./identity-collisions.js";
import { conflictMarkerKind, normalizeMirrorPath } from "./snapshot.js";

export type ConflictSection =
  | { type: "clean"; lines: string[] }
  | { type: "conflict"; ours: string[]; theirs: string[]; marker: ConflictMarker };

/**
 * Conflict marker metadata (zero-based line indexes)
 */
export interface ConflictMarker {
  start: number;
  middle: number;
  end: number;
  oursLabel: string;
  theirsLabel: string;
}

export class ConflictMarkerError extends Error {
  readonly lineNumber: number;
  readonly reason: string;

  constructor(lineNumber: number, reason: string) {
    super(`line ${lineNumber}: ${reason}`);
    this.name = "ConflictMarkerError";
    this.lineNumber = lineNumber;
    this.reason = reason;
  }
}

/**
 * Resolution result with statistics
 */
export interface ResolvedResult<T> {
  entities: T[];
  stats: ResolutionStats;
}

/**
 * Resolution statistics
 */
export interface ResolutionStats {
  totalInput: number;
  totalOutput: number;
  conflicts: ConflictResolution[];
}

/**
 * Individual conflict resolution record
 */
export interface ConflictResolution {
  type: "different-uuids" | "same-uuid-different-id" | "same-uuid-same-id";
  uuid: string;
  originalIds: string[];
  resolvedIds: string[];
  action: string;
}

/**
 * Check if file contains any git conflict marker line
 */
export function hasGitConflictMarkers(filePath: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .some((line) => conflictMarkerKind(line) !== null);
}

interface OpenConflict {
  start: number;
  middle: number | null;
  inBase: boolean;
  oursLabel: string;
  ours: string[];
  theirs: string[];
}

/**
 * Parse content containing git conflict markers into clean and conflict sections.
 *
 * The whole marker structure is validated first: every block must open with
 * <<<<<<<, may carry one ||||||| base section, must have exactly one =======
 * separator, and must close with >>>>>>> before the next block or end of
 * input. Any other sequence throws a ConflictMarkerError with its line.
 */
export function parseMergeConflictFile(content: string): ConflictSection[] {
  const lines = content.split("\n");
  const sections: ConflictSection[] = [];
  let clean: string[] = [];
  let open: OpenConflict | null = null;

  for (const [index, line] of lines.entries()) {
    const kind = conflictMarkerKind(line);
    const lineNumber = index + 1;
    if (open === null) {
      if (kind === null) {
        clean.push(line);
        continue;
      }
      if (kind !== "open") {
        throw new ConflictMarkerError(lineNumber, `${line.slice(0, 7)} without an opening <<<<<<< marker`);
      }
      if (clean.length > 0) sections.push({ type: "clean", lines: clean });
      clean = [];
      open = { start: index, middle: null, inBase: false, oursLabel: line.slice(7).trim(), ours: [], theirs: [] };
      continue;
    }
    const opened = `the conflict opened at line ${open.start + 1}`;
    if (kind === null) {
      if (open.middle !== null) open.theirs.push(line);
      else if (!open.inBase) open.ours.push(line);
      continue;
    }
    if (kind === "open") {
      throw new ConflictMarkerError(lineNumber, `<<<<<<< inside ${opened}`);
    }
    if (kind === "base") {
      if (open.middle !== null || open.inBase) {
        throw new ConflictMarkerError(lineNumber, `||||||| outside the ours side of ${opened}`);
      }
      open.inBase = true;
      continue;
    }
    if (kind === "separator") {
      if (open.middle !== null) {
        throw new ConflictMarkerError(lineNumber, `second ======= in ${opened}`);
      }
      open.middle = index;
      continue;
    }
    if (open.middle === null) {
      throw new ConflictMarkerError(lineNumber, `>>>>>>> before the ======= separator of ${opened}`);
    }
    sections.push({
      type: "conflict",
      ours: open.ours,
      theirs: open.theirs,
      marker: {
        start: open.start,
        middle: open.middle,
        end: index,
        oursLabel: open.oursLabel,
        theirsLabel: line.slice(7).trim(),
      },
    });
    open = null;
  }

  if (open !== null) {
    throw new ConflictMarkerError(
      open.start + 1,
      "conflict opened here has no closing >>>>>>> marker before the end of the file"
    );
  }
  if (clean.length > 0) sections.push({ type: "clean", lines: clean });
  return sections;
}

/**
 * Compare timestamps with normalization
 */
function compareTimestamps(
  a: string | undefined,
  b: string | undefined,
): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;

  // Normalize timestamps to ISO format
  const normalizeTs = (ts: string) => {
    const hasZone =
      ts.endsWith("Z") || ts.includes("+") || /[+-]\d{2}:\d{2}$/.test(ts);
    return hasZone ? ts : ts.replace(" ", "T") + "Z";
  };

  const dateA = new Date(normalizeTs(a));
  const dateB = new Date(normalizeTs(b));

  return dateA.getTime() - dateB.getTime();
}

/**
 * Merge metadata from multiple versions of same entity
 *
 * USE FOR: Two-way merge scenarios (manual conflict resolution)
 * Merges both array fields (union) and scalar fields (latest-wins)
 */
function latestVersion<T extends JSONLEntity>(entities: readonly T[]): T {
  const [latest] = [...entities].sort((a, b) =>
    compareTimestamps(b.updated_at, a.updated_at),
  );
  if (latest === undefined) {
    throw new IdentityResolutionError("Cannot merge an empty set of versions");
  }
  return latest;
}

export function mergeMetadata<T extends JSONLEntity>(entities: T[]): T {
  return { ...latestVersion(entities), ...mergeArrayFields(entities) };
}

/**
 * Merge ONLY array fields from multiple versions (union semantics)
 *
 * USE FOR: Three-way merge scenarios (git merge driver)
 * Only merges array fields (relationships, tags, feedback)
 * Scalar fields (status, priority, title, etc.) are NOT merged
 *
 * This allows git merge-file to see actual differences in scalar fields
 * for proper three-way merge semantics.
 */
type ArrayFields = Partial<Pick<JSONLEntity, "relationships" | "tags" | "feedback">>;

export function mergeArrayFields(entities: readonly JSONLEntity[]): ArrayFields {
  const result: ArrayFields = {};

  const relationships = new Map<string, JSONLEntity["relationships"][number]>();
  for (const entity of entities) {
    for (const relationship of entity.relationships) {
      relationships.set(JSON.stringify(relationship), relationship);
    }
  }
  if (relationships.size > 0) {
    result.relationships = Array.from(relationships.values());
  }

  const tagSet = new Set<string>();
  for (const entity of entities) {
    for (const tag of entity.tags) tagSet.add(tag);
  }
  if (tagSet.size > 0) {
    result.tags = Array.from(tagSet);
  }

  if (entities.some((entity) => entity.feedback !== undefined)) {
    const feedbackMap = new Map<string, NonNullable<JSONLEntity["feedback"]>[number]>();
    for (const entity of entities) {
      for (const fb of entity.feedback ?? []) {
        const existing = feedbackMap.get(fb.id);
        if (!existing) {
          feedbackMap.set(fb.id, fb);
          continue;
        }
        const cmp = compareTimestamps(fb.updated_at, existing.updated_at);
        if (cmp > 0 || (cmp === 0 && JSON.stringify(fb) > JSON.stringify(existing))) {
          feedbackMap.set(fb.id, fb);
        }
      }
    }
    if (feedbackMap.size > 0) {
      result.feedback = Array.from(feedbackMap.values()).sort((a, b) => {
        const cmp = compareTimestamps(a.created_at, b.created_at);
        return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
      });
    }
  }

  return result;
}

/**
 * Resolve git conflict markers in YAML content using latest-wins per block
 *
 * When git merge-file produces conflicts in YAML, this function resolves
 * each conflict block individually while preserving cleanly merged sections.
 *
 * @param yamlWithConflicts - YAML content containing git conflict markers
 * @param useOurs - If true, use "ours" side for conflicts; if false, use "theirs"
 * @returns Resolved YAML content without conflict markers
 *
 * @example
 * ```typescript
 * const yaml = `title: test
 * <<<<<<< ours
 * content: ours text
 * =======
 * content: theirs text
 * >>>>>>> theirs
 * priority: 3`;
 *
 * const resolved = resolveYamlConflicts(yaml, true);
 * // Returns: "title: test\ncontent: ours text\npriority: 3"
 * ```
 */
export function resolveYamlConflicts(
  yamlWithConflicts: string,
  useOurs: boolean,
): string {
  const sections = parseMergeConflictFile(yamlWithConflicts);
  const resolved: string[] = [];

  for (const section of sections) {
    if (section.type === "clean") {
      // Keep cleanly merged content
      resolved.push(...section.lines);
    } else {
      // Conflict block - apply latest-wins
      const chosen = useOurs ? section.ours : section.theirs;
      resolved.push(...chosen);
    }
  }

  return resolved.join("\n");
}

function entityTypeOf(entity: JSONLEntity): EntityType {
  return getEntityTypeFromId(entity.id);
}

function sideNamespace(side: readonly JSONLEntity[]): ReferenceNamespace {
  const uuids = new Set<string>();
  for (const entity of side) {
    if (uuids.has(entity.uuid)) {
      throw new IdentityResolutionError(
        `UUID ${entity.uuid} appears more than once in one merge side; remove the duplicate line, then retry`
      );
    }
    uuids.add(entity.uuid);
  }
  return createReferenceNamespace(
    side.map(entityTypeOf),
    false,
    side.map((entity) => ({
      entityType: entityTypeOf(entity),
      id: entity.id,
      uuid: entity.uuid,
    })),
  );
}

function identityClaim(entity: JSONLEntity, id = entity.id, filePath?: string): IdentityClaim {
  const entityType = entityTypeOf(entity);
  const preferredPath =
    filePath ?? ("file_path" in entity ? entity.file_path : undefined);
  return {
    entityType,
    uuid: entity.uuid,
    id,
    filePath:
      preferredPath === undefined
        ? undefined
        : normalizeMirrorPath(preferredPath),
    createdAt: entity.created_at,
    fixed: false,
  };
}

function remapVersion<T extends JSONLEntity>(
  entity: T,
  namespace: ReferenceNamespace,
  assignment: IdentityAssignment,
): T {
  return remapEntityReferences(
    entityTypeOf(entity),
    entity,
    namespace,
    assignment.identities,
  );
}

function recordCollisions(
  stats: ResolutionStats,
  assignment: IdentityAssignment,
): void {
  for (const collision of assignment.collisions) {
    stats.conflicts.push({
      type: "different-uuids",
      uuid: collision.uuid,
      originalIds: [collision.oldId],
      resolvedIds: [collision.newId],
      action: `Renamed ${collision.oldId} to ${collision.newId} to resolve an identity collision`,
    });
  }
}

function sortForSnapshot<T extends JSONLEntity>(entities: T[]): T[] {
  return entities.sort((a, b) => {
    if (a.created_at < b.created_at) return -1;
    if (a.created_at > b.created_at) return 1;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Two-way merge of complete snapshot sides (no base available).
 *
 * Each side is resolved in its own ID namespace: identities are assigned by
 * UUID first, then every reference a side wrote is remapped through that
 * side's IDs before versions of the same UUID are merged.
 */
export function resolveEntities<T extends JSONLEntity>(
  sides: readonly (readonly T[])[],
): ResolvedResult<T> {
  const stats: ResolutionStats = {
    totalInput: sides.reduce((total, side) => total + side.length, 0),
    totalOutput: 0,
    conflicts: [],
  };
  const namespaces = sides.map(sideNamespace);
  const groups = new Map<string, Array<{ side: number; entity: T }>>();
  sides.forEach((side, sideIndex) => {
    for (const entity of side) {
      const versions = groups.get(entity.uuid) ?? [];
      versions.push({ side: sideIndex, entity });
      groups.set(entity.uuid, versions);
    }
  });
  const assignment = assignIdentities(
    Array.from(groups.values(), (versions) =>
      identityClaim(latestVersion(versions.map(({ entity }) => entity))),
    ),
    { ids: [], filePaths: [] },
  );
  const resolved: T[] = [];
  for (const [uuid, versions] of groups) {
    const remapped = versions.map(({ side, entity }) =>
      remapVersion(entity, namespaces[side], assignment),
    );
    const merged = remapped.length === 1 ? remapped[0] : mergeMetadata(remapped);
    const distinct = new Set(remapped.map((entity) => JSON.stringify(entity)));
    if (distinct.size > 1) {
      const originalIds = Array.from(new Set(versions.map(({ entity }) => entity.id)));
      stats.conflicts.push({
        type: originalIds.length > 1 ? "same-uuid-different-id" : "same-uuid-same-id",
        uuid,
        originalIds,
        resolvedIds: [merged.id],
        action: `Kept most recent version, merged ${remapped.length} versions`,
      });
    }
    resolved.push(merged);
  }
  recordCollisions(stats, assignment);
  sortForSnapshot(resolved);
  stats.totalOutput = resolved.length;
  return { entities: resolved, stats };
}

function threeWayChoice<V>(
  base: V,
  ours: V,
  theirs: V,
  oursNewer: boolean,
): { value: V; conflict: boolean } {
  if (base === ours) return { value: theirs, conflict: false };
  if (base === theirs || ours === theirs) return { value: ours, conflict: false };
  return { value: oursNewer ? ours : theirs, conflict: true };
}

/**
 * Helper function to merge entities using YAML + git merge-file for line-level merging
 */
function mergeYamlWithGit<T extends JSONLEntity>(
  versions: {
    base?: T;
    ours?: T;
    theirs?: T;
  },
  originalTimestamps?: {
    ours?: string;
    theirs?: string;
  },
): { success: boolean; entity: T; hadConflicts: boolean } {
  const { base, ours, theirs } = versions;

  // Convert to YAML
  const baseYaml = base ? toYaml(base) : "";
  const oursYaml = ours ? toYaml(ours!) : "";
  const theirsYaml = theirs ? toYaml(theirs!) : "";

  // Run git merge-file for line-level merging
  const mergeResult = mergeYamlContent({
    base: baseYaml,
    ours: oursYaml,
    theirs: theirsYaml,
  });

  if (mergeResult.success && !mergeResult.hasConflicts) {
    // Clean merge - parse YAML back to JSON
    const mergedEntity = fromYaml(mergeResult.content) as T;
    return { success: true, entity: mergedEntity, hadConflicts: false };
  } else if (mergeResult.hasConflicts) {
    // YAML has conflicts - resolve each conflict block individually
    // Determine which side is newer for latest-wins decision
    // Use original timestamps if provided (since versions may have updated_at stripped)
    // When timestamps are identical, prefer ours for stability
    const oursTimestamp = originalTimestamps?.ours ?? ours?.updated_at;
    const theirsTimestamp = originalTimestamps?.theirs ?? theirs?.updated_at;
    const oursNewer = compareTimestamps(oursTimestamp, theirsTimestamp) >= 0;

    // Resolve conflict blocks, preserving cleanly merged sections
    const resolvedYaml = resolveYamlConflicts(mergeResult.content, oursNewer);
    const mergedEntity = fromYaml(resolvedYaml) as T;

    return { success: true, entity: mergedEntity, hadConflicts: true };
  } else {
    // Fatal error during merge
    return { success: false, entity: ours!, hadConflicts: false };
  }
}

/**
 * Three-way merge for git merge driver
 * Uses hybrid approach: field-level merge for scalars + line-level merge for multi-line text
 *
 * USE CASE: THREE-WAY MERGE
 * - Git merge driver operations (automatic merge)
 * - Worktree sync with true base/ours/theirs versions
 * - Field-level merging preserves changes from either branch
 *
 * DO NOT USE FOR: Manual conflict resolution (use resolveEntities)
 *
 * This function implements true three-way merge semantics:
 * 1. Group entities by UUID across base/ours/theirs
 * 2. Handle deletion cases (modification wins over deletion)
 * 3. Merge array fields FIRST (tags, relationships, feedback) with union semantics
 * 4. Field-level three-way merge for SCALAR fields only (status, priority, etc.)
 * 5. YAML + git merge-file for multi-line text fields (content, description)
 * 6. Assign identities by UUID before merging; each side's references are
 *    remapped through that side's own ID namespace
 * 7. Sort by created_at (git-friendly)
 *
 * Field-level three-way merge logic:
 * - If base == ours == theirs: use any value (no changes)
 * - If base == ours && base != theirs: use theirs (only theirs changed)
 * - If base == theirs && base != ours: use ours (only ours changed)
 * - If base != ours && base != theirs && ours == theirs: use either (both made same change)
 * - If base != ours && base != theirs && ours != theirs: conflict -> latest wins
 */
type ThreeWayVersions<T> = { base?: T; ours?: T; theirs?: T };

type ThreeWayPlan<T> =
  | { kind: "single"; side: "ours" | "theirs"; entity: T; deletedOn?: "ours" | "theirs" }
  | { kind: "pair"; ours: T; theirs: T }
  | { kind: "three"; base: T; ours: T; theirs: T };

function planThreeWay<T>(versions: ThreeWayVersions<T>): ThreeWayPlan<T> | null {
  const { base, ours, theirs } = versions;
  if (ours && theirs) {
    return base ? { kind: "three", base, ours, theirs } : { kind: "pair", ours, theirs };
  }
  if (ours) return { kind: "single", side: "ours", entity: ours, deletedOn: base ? "theirs" : undefined };
  if (theirs) return { kind: "single", side: "theirs", entity: theirs, deletedOn: base ? "ours" : undefined };
  return null;
}

function threeWayClaim<T extends JSONLEntity>(plan: ThreeWayPlan<T>): IdentityClaim {
  if (plan.kind === "single") return identityClaim(plan.entity);
  if (plan.kind === "pair") return identityClaim(latestVersion([plan.ours, plan.theirs]));
  const oursNewer = compareTimestamps(plan.ours.updated_at, plan.theirs.updated_at) >= 0;
  const filePath = (entity: T): string | undefined =>
    "file_path" in entity ? entity.file_path : undefined;
  return identityClaim(
    plan.ours,
    threeWayChoice(plan.base.id, plan.ours.id, plan.theirs.id, oursNewer).value,
    threeWayChoice(filePath(plan.base), filePath(plan.ours), filePath(plan.theirs), oursNewer).value,
  );
}

function mergeThreeVersions<T extends JSONLEntity>(
  uuid: string,
  baseEntity: T,
  oursEntity: T,
  theirsEntity: T,
  stats: ResolutionStats,
): T {
  const arrayFieldsMerged = mergeArrayFields([baseEntity, oursEntity, theirsEntity]);

  const allFields = new Set<string>();
  for (const entity of [baseEntity, oursEntity, theirsEntity]) {
    for (const key of Object.keys(entity)) {
      if (key === "relationships" || key === "tags" || key === "feedback") continue;
      allFields.add(key);
    }
  }

  const fieldsMerged: Record<string, unknown> = { ...arrayFieldsMerged };
  const scalarConflicts: string[] = [];
  const multiLineFields = new Set(["content", "description"]);
  const oursNewer =
    compareTimestamps(oursEntity.updated_at, theirsEntity.updated_at) >= 0;
  const latestUpdatedAt =
    compareTimestamps(oursEntity.updated_at, theirsEntity.updated_at) > 0
      ? oursEntity.updated_at
      : theirsEntity.updated_at;

  for (const field of allFields) {
    if (multiLineFields.has(field) || field === "updated_at") continue;
    const choice = threeWayChoice(
      baseEntity[field as keyof T],
      oursEntity[field as keyof T],
      theirsEntity[field as keyof T],
      oursNewer,
    );
    fieldsMerged[field] = choice.value;
    if (choice.conflict) scalarConflicts.push(field);
  }

  const multiLineFieldsIdentical = Array.from(multiLineFields).every((field) => {
    const baseValue = baseEntity[field as keyof T];
    return (
      baseValue === oursEntity[field as keyof T] &&
      baseValue === theirsEntity[field as keyof T]
    );
  });

  let mergedEntity: T;
  let hadYamlConflicts = false;
  if (scalarConflicts.length === 0 && multiLineFieldsIdentical) {
    mergedEntity = { ...oursEntity, ...fieldsMerged } as T;
  } else {
    const versionsForYaml = {
      base: { ...baseEntity, ...fieldsMerged, updated_at: undefined },
      ours: { ...oursEntity, ...fieldsMerged, updated_at: undefined },
      theirs: { ...theirsEntity, ...fieldsMerged, updated_at: undefined },
    };
    const yamlMergeResult = mergeYamlWithGit(versionsForYaml, {
      ours: oursEntity.updated_at,
      theirs: theirsEntity.updated_at,
    });
    hadYamlConflicts = yamlMergeResult.hadConflicts;
    if (yamlMergeResult.success) {
      mergedEntity = { ...yamlMergeResult.entity, ...arrayFieldsMerged } as T;
    } else {
      mergedEntity = (oursNewer ? versionsForYaml.ours : versionsForYaml.theirs) as T;
    }
  }
  mergedEntity.updated_at = latestUpdatedAt;

  if (scalarConflicts.length > 0 || hadYamlConflicts) {
    const conflictParts = [];
    if (scalarConflicts.length > 0) {
      conflictParts.push(
        `${scalarConflicts.length} scalar field conflicts (${scalarConflicts.join(", ")})`,
      );
    }
    if (hadYamlConflicts) {
      conflictParts.push("YAML conflict blocks (latest-wins per block)");
    }
    stats.conflicts.push({
      type: "same-uuid-same-id",
      uuid,
      originalIds: [baseEntity.id],
      resolvedIds: [mergedEntity.id],
      action: `Resolved ${conflictParts.join(", ")}`,
    });
  }
  return mergedEntity;
}

export function mergeThreeWay<T extends JSONLEntity>(
  base: T[],
  ours: T[],
  theirs: T[],
): ResolvedResult<T> {
  const stats: ResolutionStats = {
    totalInput: base.length + ours.length + theirs.length,
    totalOutput: 0,
    conflicts: [],
  };
  const namespaces = {
    base: sideNamespace(base),
    ours: sideNamespace(ours),
    theirs: sideNamespace(theirs),
  };
  const byUuid = new Map<string, ThreeWayVersions<T>>();
  for (const [side, entities] of [["base", base], ["ours", ours], ["theirs", theirs]] as const) {
    for (const entity of entities) {
      byUuid.set(entity.uuid, { ...byUuid.get(entity.uuid), [side]: entity });
    }
  }

  const plans: Array<[string, ThreeWayPlan<T>]> = [];
  for (const [uuid, versions] of byUuid) {
    const plan = planThreeWay(versions);
    if (plan) plans.push([uuid, plan]);
  }
  const assignment = assignIdentities(
    plans.map(([, plan]) => threeWayClaim(plan)),
    { ids: [], filePaths: [] },
  );
  const remap = (entity: T, side: keyof typeof namespaces): T =>
    remapVersion(entity, namespaces[side], assignment);

  const mergedEntities: T[] = [];
  for (const [uuid, plan] of plans) {
    if (plan.kind === "single") {
      const entity = remap(plan.entity, plan.side);
      if (plan.deletedOn) {
        stats.conflicts.push({
          type: "same-uuid-same-id",
          uuid,
          originalIds: [plan.entity.id],
          resolvedIds: [entity.id],
          action: `Kept ${plan.side} (deleted in ${plan.deletedOn}, modified in ${plan.side})`,
        });
      }
      mergedEntities.push(entity);
      continue;
    }
    if (plan.kind === "pair") {
      const merged = mergeMetadata([remap(plan.ours, "ours"), remap(plan.theirs, "theirs")]);
      stats.conflicts.push({
        type: "same-uuid-same-id",
        uuid,
        originalIds: Array.from(new Set([plan.ours.id, plan.theirs.id])),
        resolvedIds: [merged.id],
        action: "Added on both sides; kept most recent version, merged 2 versions",
      });
      mergedEntities.push(merged);
      continue;
    }
    mergedEntities.push(
      mergeThreeVersions(
        uuid,
        remap(plan.base, "base"),
        remap(plan.ours, "ours"),
        remap(plan.theirs, "theirs"),
        stats,
      ),
    );
  }
  recordCollisions(stats, assignment);
  sortForSnapshot(mergedEntities);
  stats.totalOutput = mergedEntities.length;
  return { entities: mergedEntities, stats };
}

import * as fs from "fs";
import * as path from "path";
import type {
  AdrJSONL,
  EntityType,
  FeedbackAnchor,
  FeedbackJSONL,
  IssueJSONL,
  RelationshipJSONL,
  SpecJSONL,
} from "./types.js";
import {
  ENTITY_ROWS,
  ENTITY_TYPE_VALUES,
  getEntityRow,
  getEntityTypeFromId,
  isEntityType,
  isHashID,
  isLegacyID,
  type DocumentEntityType,
  type EntitySnapshot,
  type EntitySnapshots,
} from "@sudocode-ai/types/entities";
import { decodeExternalLinks } from "./external-links.js";
import { digestJSONLContent, type JSONLFileDigest } from "./jsonl-sync-state.js";
import {
  getValidAnchorStatuses,
  isValidAnchorStatus,
  isValidFeedbackType,
  isValidIssueStatus,
  isValidRelationshipType,
} from "./validation.js";

const LINE_RECOVERY = "Restore or correct that JSONL line, then retry.";

export class SnapshotDecodeError extends Error {
  readonly filePath: string;
  readonly lineNumber: number;
  readonly field: string;
  readonly recovery: string;

  constructor(
    filePath: string,
    lineNumber: number,
    field: string,
    reason: string,
    recovery: string
  ) {
    super(
      `${filePath}:${lineNumber}: invalid ${field}: ${reason}. ${recovery} No snapshot changes were applied.`
    );
    this.name = "SnapshotDecodeError";
    this.filePath = filePath;
    this.lineNumber = lineNumber;
    this.field = field;
    this.recovery = recovery;
  }
}

interface DecodeContext {
  filePath: string;
  lineNumber: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(
  context: DecodeContext,
  field: string,
  reason: string
): never {
  throw new SnapshotDecodeError(
    context.filePath,
    context.lineNumber,
    field,
    reason,
    LINE_RECOVERY
  );
}

function requiredString(
  context: DecodeContext,
  record: Record<string, unknown>,
  field: string
): string {
  const value = record[field];
  if (typeof value !== "string") {
    fail(context, field, `expected a string, received ${describe(value)}`);
  }
  return value;
}

function nullableString(
  context: DecodeContext,
  record: Record<string, unknown>,
  field: string
): string | undefined {
  const value = record[field];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    fail(context, field, `expected a string or null, received ${describe(value)}`);
  }
  return value;
}

function decodeParentUuid(
  context: DecodeContext,
  record: Record<string, unknown>,
  id: string,
  parentId: string | undefined
): string | undefined {
  const parentUuid = nullableString(context, record, "parent_uuid");
  if (parentUuid !== undefined && parentId === undefined) {
    fail(context, "parent_uuid", `${id} names parent ${parentUuid} without a parent_id; a root has neither`);
  }
  return parentUuid;
}

function requiredNumber(
  context: DecodeContext,
  record: Record<string, unknown>,
  field: string
): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(context, field, `expected a finite number, received ${describe(value)}`);
  }
  return value;
}

function persistedBoolean(
  context: DecodeContext,
  record: Record<string, unknown>,
  field: string
): boolean | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (value === 0) return false;
  if (value === 1) return true;
  fail(context, field, `expected true, false, 0, or 1, received ${describe(value)}`);
}

function describe(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? String(value) : encoded.slice(0, 120);
  } catch {
    return String(value);
  }
}

function decodeSnapshotExternalLinks(
  context: DecodeContext,
  record: Record<string, unknown>
): ReturnType<typeof decodeExternalLinks> {
  try {
    return decodeExternalLinks(record.external_links);
  } catch (error) {
    fail(context, "external_links", error instanceof Error ? error.message : String(error));
  }
}

function decodeTags(context: DecodeContext, record: Record<string, unknown>): string[] {
  const tags = record.tags;
  if (!Array.isArray(tags)) {
    fail(context, "tags", `expected an array, received ${describe(tags)}`);
  }
  return tags.map((tag, index) => {
    if (typeof tag !== "string") {
      fail(context, `tags[${index}]`, `expected a string, received ${describe(tag)}`);
    }
    return tag;
  });
}

function decodeEntityType(context: DecodeContext, value: unknown, field: string): EntityType {
  if (!isEntityType(value)) {
    fail(context, field, `expected one of ${ENTITY_TYPE_VALUES.join(", ")}, received ${describe(value)}`);
  }
  return value;
}

function decodeRelationships(
  context: DecodeContext,
  record: Record<string, unknown>
): RelationshipJSONL[] {
  const relationships = record.relationships;
  if (!Array.isArray(relationships)) {
    fail(context, "relationships", `expected an array, received ${describe(relationships)}`);
  }
  return relationships.map((relationship, index): RelationshipJSONL => {
    const field = `relationships[${index}]`;
    if (!isRecord(relationship)) {
      fail(context, field, `expected an object, received ${describe(relationship)}`);
    }
    const type = relationship.type;
    if (typeof type !== "string" || !isValidRelationshipType(type)) {
      fail(context, `${field}.type`, `unknown relationship type ${describe(type)}`);
    }
    const from = requiredString(context, relationship, "from");
    const fromType = decodeEntityType(context, relationship.from_type, `${field}.from_type`);
    const to = requiredString(context, relationship, "to");
    const toType = decodeEntityType(context, relationship.to_type, `${field}.to_type`);
    decodeEntityId(context, from, fromType, `${field}.from`);
    decodeEntityId(context, to, toType, `${field}.to`);
    return {
      from,
      from_type: fromType,
      to,
      to_type: toType,
      type,
    };
  });
}

function decodeAnchor(
  context: DecodeContext,
  value: unknown,
  field: string
): FeedbackAnchor | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    fail(context, field, `expected an object or null, received ${describe(value)}`);
  }
  const status = value.anchor_status;
  if (!isValidAnchorStatus(status)) {
    fail(context, `${field}.anchor_status`, `expected one of ${getValidAnchorStatuses().join(", ")}, received ${describe(status)}`);
  }
  const originalLocation = value.original_location;
  if (originalLocation !== undefined && !isRecord(originalLocation)) {
    fail(context, `${field}.original_location`, "expected an object");
  }
  const decodeNumber = (name: string): number | undefined => {
    const numberValue = value[name];
    if (numberValue === undefined) return undefined;
    if (typeof numberValue !== "number") {
      fail(context, `${field}.${name}`, `expected a number, received ${describe(numberValue)}`);
    }
    return numberValue;
  };
  let originalLocationValue: FeedbackAnchor["original_location"];
  if (originalLocation !== undefined) {
    const originalLineNumberValue = originalLocation.line_number;
    if (typeof originalLineNumberValue !== "number") {
      fail(context, `${field}.original_location.line_number`, "expected a number");
    }
    const originalSectionHeadingValue = originalLocation.section_heading;
    if (
      originalSectionHeadingValue !== undefined &&
      typeof originalSectionHeadingValue !== "string"
    ) {
      fail(context, `${field}.original_location.section_heading`, "expected a string");
    }
    originalLocationValue = {
      line_number: originalLineNumberValue,
      section_heading: originalSectionHeadingValue,
    };
  }
  return {
    section_heading: nullableString(context, value, "section_heading"),
    section_level: decodeNumber("section_level"),
    line_number: decodeNumber("line_number"),
    line_offset: decodeNumber("line_offset"),
    text_snippet: nullableString(context, value, "text_snippet"),
    context_before: nullableString(context, value, "context_before"),
    context_after: nullableString(context, value, "context_after"),
    content_hash: nullableString(context, value, "content_hash"),
    anchor_status: status,
    last_verified_at: nullableString(context, value, "last_verified_at"),
    original_location: originalLocationValue,
  };
}

function decodeFeedback(
  context: DecodeContext,
  record: Record<string, unknown>
): FeedbackJSONL[] | undefined {
  const feedback = record.feedback;
  if (feedback === undefined || feedback === null) return undefined;
  if (!Array.isArray(feedback)) {
    fail(context, "feedback", `expected an array, received ${describe(feedback)}`);
  }
  return feedback.map((entry, index): FeedbackJSONL => {
    const field = `feedback[${index}]`;
    if (!isRecord(entry)) {
      fail(context, field, `expected an object, received ${describe(entry)}`);
    }
    const feedbackType = entry.feedback_type;
    if (typeof feedbackType !== "string" || !isValidFeedbackType(feedbackType)) {
      fail(context, `${field}.feedback_type`, `unknown feedback type ${describe(feedbackType)}`);
    }
    const dismissed = entry.dismissed;
    if (dismissed !== undefined && typeof dismissed !== "boolean") {
      fail(context, `${field}.dismissed`, `expected a boolean, received ${describe(dismissed)}`);
    }
    return {
      id: requiredString(context, entry, "id"),
      from_id: nullableString(context, entry, "from_id"),
      to_id: requiredString(context, entry, "to_id"),
      feedback_type: feedbackType,
      content: requiredString(context, entry, "content"),
      agent: nullableString(context, entry, "agent"),
      anchor: decodeAnchor(context, entry.anchor, `${field}.anchor`),
      dismissed,
      created_at: requiredString(context, entry, "created_at"),
      updated_at: requiredString(context, entry, "updated_at"),
    };
  });
}

function decodeEntityId(
  context: DecodeContext,
  id: string,
  entityType: EntityType,
  field = "id"
): void {
  if (!isHashID(id) && !isLegacyID(id)) {
    fail(context, field, `${id} does not match the ${entityType} ID grammar`);
  }
  let actualType: EntityType;
  try {
    actualType = getEntityTypeFromId(id);
  } catch (error) {
    fail(context, field, error instanceof Error ? error.message : String(error));
  }
  if (actualType !== entityType) {
    fail(context, field, `${id} belongs to ${actualType}, not ${entityType}`);
  }
}

export function normalizeMirrorPath(
  filePath: string,
  entityType?: DocumentEntityType
): string {
  const normalized = path.posix.normalize(filePath);
  const segments = normalized.split("/");
  const validDirs = entityType
    ? [getEntityRow(entityType).markdownDir]
    : ENTITY_ROWS.filter((row) => row.type !== "issue").map((row) => row.markdownDir);
  if (
    filePath.includes("\\") ||
    path.posix.isAbsolute(normalized) ||
    normalized.endsWith("/") ||
    segments.length < 2 ||
    segments.some((segment) => segment.length === 0 || segment === ".." || segment === ".") ||
    !validDirs.includes(segments[0] as (typeof validDirs)[number])
  ) {
    const targetDir = entityType ? `${getEntityRow(entityType).markdownDir}/` : "a valid document directory";
    throw new Error(`${filePath} must stay inside ${targetDir}`);
  }
  return normalized;
}

function decodeMirrorPath(
  context: DecodeContext,
  record: Record<string, unknown>,
  entityType: DocumentEntityType
): string {
  const filePath = requiredString(context, record, "file_path");
  try {
    return normalizeMirrorPath(filePath, entityType);
  } catch (error) {
    fail(context, "file_path", error instanceof Error ? error.message : String(error));
  }
}

function decodeSpec(context: DecodeContext, value: unknown): SpecJSONL {
  if (!isRecord(value)) fail(context, "$", `expected an object, received ${describe(value)}`);
  const id = requiredString(context, value, "id");
  decodeEntityId(context, id, "spec");
  const parentId = nullableString(context, value, "parent_id");
  if (parentId !== undefined) {
    decodeEntityId(context, parentId, "spec", "parent_id");
  }
  return {
    id,
    uuid: requiredString(context, value, "uuid"),
    title: requiredString(context, value, "title"),
    file_path: decodeMirrorPath(context, value, "spec"),
    content: requiredString(context, value, "content"),
    priority: requiredNumber(context, value, "priority"),
    archived: persistedBoolean(context, value, "archived"),
    archived_at: nullableString(context, value, "archived_at"),
    created_at: requiredString(context, value, "created_at"),
    updated_at: requiredString(context, value, "updated_at"),
    parent_id: parentId,
    parent_uuid: decodeParentUuid(context, value, id, parentId),
    external_links: decodeSnapshotExternalLinks(context, value),
    relationships: decodeRelationships(context, value),
    tags: decodeTags(context, value),
    feedback: decodeFeedback(context, value),
  };
}

function decodeIssue(context: DecodeContext, value: unknown): IssueJSONL {
  if (!isRecord(value)) fail(context, "$", `expected an object, received ${describe(value)}`);
  const id = requiredString(context, value, "id");
  decodeEntityId(context, id, "issue");
  const status = value.status;
  if (typeof status !== "string" || !isValidIssueStatus(status)) {
    fail(context, "status", `unknown issue status ${describe(status)}`);
  }
  const parentId = nullableString(context, value, "parent_id");
  if (parentId !== undefined) {
    decodeEntityId(context, parentId, "issue", "parent_id");
  }
  return {
    id,
    uuid: requiredString(context, value, "uuid"),
    title: requiredString(context, value, "title"),
    content: requiredString(context, value, "content"),
    status,
    priority: requiredNumber(context, value, "priority"),
    assignee: nullableString(context, value, "assignee"),
    archived: persistedBoolean(context, value, "archived"),
    archived_at: nullableString(context, value, "archived_at"),
    created_at: requiredString(context, value, "created_at"),
    updated_at: requiredString(context, value, "updated_at"),
    closed_at: nullableString(context, value, "closed_at"),
    parent_id: parentId,
    parent_uuid: decodeParentUuid(context, value, id, parentId),
    external_links: decodeSnapshotExternalLinks(context, value),
    relationships: decodeRelationships(context, value),
    tags: decodeTags(context, value),
    feedback: decodeFeedback(context, value),
  };
}

function decodeAdr(context: DecodeContext, value: unknown): AdrJSONL {
  if (!isRecord(value)) fail(context, "$", `expected an object, received ${describe(value)}`);
  const id = requiredString(context, value, "id");
  decodeEntityId(context, id, "adr");
  return {
    id,
    uuid: requiredString(context, value, "uuid"),
    title: requiredString(context, value, "title"),
    file_path: decodeMirrorPath(context, value, "adr"),
    content: requiredString(context, value, "content"),
    archived: persistedBoolean(context, value, "archived"),
    archived_at: nullableString(context, value, "archived_at"),
    created_at: requiredString(context, value, "created_at"),
    updated_at: requiredString(context, value, "updated_at"),
    external_links: decodeSnapshotExternalLinks(context, value),
    relationships: decodeRelationships(context, value),
    tags: decodeTags(context, value),
    feedback: decodeFeedback(context, value),
  };
}

function validateFeedbackOwnership(
  context: DecodeContext,
  entityType: EntityType,
  entity: SpecJSONL | IssueJSONL | AdrJSONL,
  feedbackIds: Set<string>
): void {
  for (const feedback of entity.feedback ?? []) {
    if (feedbackIds.has(feedback.id)) {
      fail(context, `feedback.${feedback.id}`, "feedback ID is stored by more than one owner");
    }
    feedbackIds.add(feedback.id);
    let toType: EntityType;
    try {
      toType = getEntityTypeFromId(feedback.to_id);
    } catch (error) {
      fail(context, `feedback.${feedback.id}.to_id`, error instanceof Error ? error.message : String(error));
    }
    decodeEntityId(context, feedback.to_id, toType, `feedback.${feedback.id}.to_id`);
    if (feedback.from_id !== undefined) {
      let fromType: EntityType;
      try {
        fromType = getEntityTypeFromId(feedback.from_id);
      } catch (error) {
        fail(context, `feedback.${feedback.id}.from_id`, error instanceof Error ? error.message : String(error));
      }
      decodeEntityId(context, feedback.from_id, fromType, `feedback.${feedback.id}.from_id`);
      if (fromType !== "issue" || entityType !== "issue" || entity.id !== feedback.from_id) {
        fail(context, `feedback.${feedback.id}.from_id`, `issue-originated feedback must be stored only on ${feedback.from_id}`);
      }
      continue;
    }
    if (entityType !== toType || entity.id !== feedback.to_id) {
      fail(context, `feedback.${feedback.id}.to_id`, `anonymous feedback must be stored only on its target ${feedback.to_id}`);
    }
  }
}

type SnapshotDecoders = {
  [K in EntityType]: (context: DecodeContext, value: unknown) => EntitySnapshot<K>;
};

const SNAPSHOT_DECODERS = {
  spec: decodeSpec,
  issue: decodeIssue,
  adr: decodeAdr,
} satisfies SnapshotDecoders;

function decodeSelectedSnapshot<K extends EntityType>(
  decoder: SnapshotDecoders[K],
  context: DecodeContext,
  value: unknown
): EntitySnapshot<K> {
  return decoder(context, value);
}

export function decodeSnapshotValue<K extends EntityType>(
  entityType: K,
  context: DecodeContext,
  value: unknown
): EntitySnapshot<K> {
  return decodeSelectedSnapshot(SNAPSHOT_DECODERS[entityType], context, value);
}

const CONFLICT_MARKERS = {
  "<<<<<<<": "open",
  "|||||||": "base",
  "=======": "separator",
  ">>>>>>>": "close",
} as const;

export type ConflictMarkerKind = (typeof CONFLICT_MARKERS)[keyof typeof CONFLICT_MARKERS];

function isConflictMarkerPrefix(prefix: string): prefix is keyof typeof CONFLICT_MARKERS {
  return Object.prototype.hasOwnProperty.call(CONFLICT_MARKERS, prefix);
}

export function conflictMarkerKind(line: string): ConflictMarkerKind | null {
  const prefix = line.slice(0, 7);
  return isConflictMarkerPrefix(prefix) ? CONFLICT_MARKERS[prefix] : null;
}

export function conflictStructureRecovery(filePath: string): string {
  return `Finish that conflict block by hand so it has <<<<<<<, ======= and >>>>>>> markers in order, or recreate the markers with \`git checkout --merge -- ${filePath}\`, then rerun \`sudocode resolve-conflicts\`.`;
}

export function decodeSnapshotLine<K extends EntityType>(
  filePath: string,
  entityType: K,
  line: string,
  lineNumber: number,
  feedbackIds = new Set<string>()
): EntitySnapshot<K> | null {
  if (line.trim() === "") return null;
  const context = { filePath, lineNumber };
  if (conflictMarkerKind(line) !== null) {
    throw new SnapshotDecodeError(
      filePath,
      lineNumber,
      "$",
      "unresolved git conflict marker",
      "Run `sudocode resolve-conflicts` (add `--dry-run` to preview), then retry."
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    fail(context, "$", error instanceof Error ? error.message : String(error));
  }
  const entity = decodeSnapshotValue(entityType, context, value);
  validateFeedbackOwnership(context, entityType, entity, feedbackIds);
  return entity;
}

export function decodeSnapshotContent<K extends EntityType>(
  filePath: string,
  entityType: K,
  content: string,
  feedbackIds = new Set<string>(),
  firstLineNumber = 1
): EntitySnapshot<K>[] {
  const lines = content.split("\n");
  const entities: EntitySnapshot<K>[] = [];
  for (const [index, line] of lines.entries()) {
    const entity = decodeSnapshotLine(
      filePath,
      entityType,
      line,
      firstLineNumber + index,
      feedbackIds
    );
    if (entity !== null) entities.push(entity);
  }
  return entities;
}

export function validateSnapshotEntities<K extends EntityType>(
  filePath: string,
  entityType: K,
  entities: readonly unknown[],
  feedbackIds = new Set<string>()
): EntitySnapshot<K>[] {
  const content = entities.map((entity) => JSON.stringify(entity)).join("\n");
  return decodeSnapshotContent(filePath, entityType, content, feedbackIds);
}

function missingSnapshotFile(filePath: string, entityType: EntityType): never {
  throw new SnapshotDecodeError(
    filePath,
    0,
    "$",
    "required snapshot file is missing",
    `Restore it with \`git checkout -- ${filePath}\`, or create an empty file to declare that no ${getEntityRow(entityType).pluralLabel} exist, then retry.`
  );
}

export function inferSnapshotEntityType(
  filePaths: readonly string[]
): EntityType | null {
  for (const filePath of filePaths) {
    const row = ENTITY_ROWS.find(
      (candidate) => candidate.jsonlFile === path.basename(filePath)
    );
    if (row) return row.type;
  }
  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath)) {
      throw new SnapshotDecodeError(
        filePath,
        0,
        "$",
        "merge input file is missing",
        "Rerun the merge so git supplies every stage file."
      );
    }
    const lines = fs.readFileSync(filePath, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "") continue;
      const context = { filePath, lineNumber: index + 1 };
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        fail(context, "$", error instanceof Error ? error.message : String(error));
      }
      if (!isRecord(parsed)) fail(context, "$", `expected an object, received ${describe(parsed)}`);
      const id = requiredString(context, parsed, "id");
      try {
        return getEntityTypeFromId(id);
      } catch (error) {
        fail(context, "id", error instanceof Error ? error.message : String(error));
      }
    }
  }
  return null;
}

function readSnapshotFile<K extends EntityType>(
  filePath: string,
  entityType: K,
  feedbackIds: Set<string>
): { entities: EntitySnapshot<K>[]; digest: JSONLFileDigest } {
  if (!fs.existsSync(filePath)) missingSnapshotFile(filePath, entityType);
  const content = fs.readFileSync(filePath, "utf8");
  return {
    entities: decodeSnapshotContent(filePath, entityType, content, feedbackIds),
    digest: digestJSONLContent(filePath, content),
  };
}

export function readEntitySnapshotFile<K extends EntityType>(
  filePath: string,
  entityType: K,
  feedbackIds = new Set<string>()
): EntitySnapshot<K>[] {
  return readSnapshotFile(filePath, entityType, feedbackIds).entities;
}

export type SnapshotFileNames = Partial<Record<EntityType, string>>;

export function snapshotFilePath(
  inputDir: string,
  entityType: EntityType,
  fileNames: SnapshotFileNames = {}
): string {
  return path.join(inputDir, fileNames[entityType] ?? getEntityRow(entityType).jsonlFile);
}

export interface PersistedSnapshot {
  entities: EntitySnapshots;
  /** The digest of each file exactly as decoded into `entities` */
  digests: JSONLFileDigest[];
}

export function readPersistedSnapshot(
  inputDir: string,
  fileNames: SnapshotFileNames = {}
): PersistedSnapshot {
  const feedbackIds = new Set<string>();
  const spec = readSnapshotFile(snapshotFilePath(inputDir, "spec", fileNames), "spec", feedbackIds);
  const issue = readSnapshotFile(snapshotFilePath(inputDir, "issue", fileNames), "issue", feedbackIds);
  const adr = readSnapshotFile(snapshotFilePath(inputDir, "adr", fileNames), "adr", feedbackIds);
  return {
    entities: { spec: spec.entities, issue: issue.entities, adr: adr.entities },
    digests: [spec.digest, issue.digest, adr.digest],
  };
}

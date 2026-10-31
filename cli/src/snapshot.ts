import * as fs from "fs";
import * as path from "path";
import type {
  AdrJSONL,
  EntityType,
  ExternalLink,
  FeedbackAnchor,
  FeedbackJSONL,
  IssueJSONL,
  RelationshipJSONL,
  SpecJSONL,
} from "./types.js";
import {
  ENTITY_TYPE_VALUES,
  getEntityRow,
  getEntityTypeFromId,
  isEntityType,
  type EntitySnapshots,
} from "@sudocode-ai/types/entities";
import { isValidIssueStatus, isValidRelationshipType } from "./validation.js";

export class SnapshotDecodeError extends Error {
  readonly filePath: string;
  readonly lineNumber: number;
  readonly field: string;
  readonly recovery: string;

  constructor(filePath: string, lineNumber: number, field: string, reason: string) {
    super(
      `${filePath}:${lineNumber}: invalid ${field}: ${reason}. Restore or correct that JSONL line, then retry; no snapshot changes were applied.`
    );
    this.name = "SnapshotDecodeError";
    this.filePath = filePath;
    this.lineNumber = lineNumber;
    this.field = field;
    this.recovery = "correct-or-restore-line-then-retry";
  }
}

interface DecodeContext {
  filePath: string;
  lineNumber: number;
}

export interface SnapshotFileNames {
  spec?: string;
  issue?: string;
  adr?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(
  context: DecodeContext,
  field: string,
  reason: string
): never {
  throw new SnapshotDecodeError(context.filePath, context.lineNumber, field, reason);
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

function decodeExternalLinks(
  context: DecodeContext,
  record: Record<string, unknown>
): ExternalLink[] | undefined {
  const value = record.external_links;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    fail(context, "external_links", `expected an array, received ${describe(value)}`);
  }
  return value.map((link, index): ExternalLink => {
    const field = `external_links[${index}]`;
    if (!isRecord(link)) fail(context, field, `expected an object, received ${describe(link)}`);
    const provider = requiredString(context, link, "provider");
    const externalId = requiredString(context, link, "external_id");
    const syncEnabled = link.sync_enabled;
    if (typeof syncEnabled !== "boolean") {
      fail(context, "sync_enabled", `expected a boolean, received ${describe(syncEnabled)}`);
    }
    const syncDirection = link.sync_direction;
    if (
      syncDirection !== "inbound" &&
      syncDirection !== "outbound" &&
      syncDirection !== "bidirectional"
    ) {
      fail(context, "sync_direction", "expected inbound, outbound, or bidirectional");
    }
    const metadata = link.metadata;
    const importMetadata = link.import_metadata;
    if (metadata !== undefined && !isRecord(metadata)) {
      fail(context, "metadata", "expected an object");
    }
    if (importMetadata !== undefined && !isRecord(importMetadata)) {
      fail(context, "import_metadata", "expected an object");
    }
    return {
      provider,
      external_id: externalId,
      external_url: nullableString(context, link, "external_url"),
      sync_enabled: syncEnabled,
      sync_direction: syncDirection,
      last_synced_at: nullableString(context, link, "last_synced_at"),
      external_updated_at: nullableString(context, link, "external_updated_at"),
      metadata,
      imported_at: nullableString(context, link, "imported_at"),
      content_hash: nullableString(context, link, "content_hash"),
      import_metadata: importMetadata,
    };
  });
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
    return {
      from: requiredString(context, relationship, "from"),
      from_type: decodeEntityType(context, relationship.from_type, `${field}.from_type`),
      to: requiredString(context, relationship, "to"),
      to_type: decodeEntityType(context, relationship.to_type, `${field}.to_type`),
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
  if (status !== "valid" && status !== "relocated" && status !== "stale") {
    fail(context, `${field}.anchor_status`, "expected valid, relocated, or stale");
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
    if (
      feedbackType !== "comment" &&
      feedbackType !== "suggestion" &&
      feedbackType !== "request"
    ) {
      fail(context, `${field}.feedback_type`, "expected comment, suggestion, or request");
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
  entityType: EntityType
): void {
  let actualType: EntityType;
  try {
    actualType = getEntityTypeFromId(id);
  } catch (error) {
    fail(context, "id", error instanceof Error ? error.message : String(error));
  }
  if (actualType !== entityType) {
    fail(context, "id", `${id} belongs to ${actualType}, not ${entityType}`);
  }
}

function decodeSpec(context: DecodeContext, value: unknown): SpecJSONL {
  if (!isRecord(value)) fail(context, "$", `expected an object, received ${describe(value)}`);
  const id = requiredString(context, value, "id");
  decodeEntityId(context, id, "spec");
  return {
    id,
    uuid: requiredString(context, value, "uuid"),
    title: requiredString(context, value, "title"),
    file_path: requiredString(context, value, "file_path"),
    content: requiredString(context, value, "content"),
    priority: requiredNumber(context, value, "priority"),
    archived: persistedBoolean(context, value, "archived"),
    archived_at: nullableString(context, value, "archived_at"),
    created_at: requiredString(context, value, "created_at"),
    updated_at: requiredString(context, value, "updated_at"),
    parent_id: nullableString(context, value, "parent_id"),
    parent_uuid: nullableString(context, value, "parent_uuid"),
    external_links: decodeExternalLinks(context, value),
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
    parent_id: nullableString(context, value, "parent_id"),
    parent_uuid: nullableString(context, value, "parent_uuid"),
    external_links: decodeExternalLinks(context, value),
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
    file_path: requiredString(context, value, "file_path"),
    content: requiredString(context, value, "content"),
    archived: persistedBoolean(context, value, "archived"),
    archived_at: nullableString(context, value, "archived_at"),
    created_at: requiredString(context, value, "created_at"),
    updated_at: requiredString(context, value, "updated_at"),
    external_links: decodeExternalLinks(context, value),
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
    if (feedback.from_id !== undefined) {
      let fromType: EntityType;
      try {
        fromType = getEntityTypeFromId(feedback.from_id);
      } catch (error) {
        fail(context, `feedback.${feedback.id}.from_id`, error instanceof Error ? error.message : String(error));
      }
      if (fromType !== "issue" || entityType !== "issue" || entity.id !== feedback.from_id) {
        fail(context, `feedback.${feedback.id}.from_id`, `issue-originated feedback must be stored only on ${feedback.from_id}`);
      }
      continue;
    }
    let toType: EntityType;
    try {
      toType = getEntityTypeFromId(feedback.to_id);
    } catch (error) {
      fail(context, `feedback.${feedback.id}.to_id`, error instanceof Error ? error.message : String(error));
    }
    if (entityType !== toType || entity.id !== feedback.to_id) {
      fail(context, `feedback.${feedback.id}.to_id`, `anonymous feedback must be stored only on its target ${feedback.to_id}`);
    }
  }
}

function readSnapshotLines<T extends SpecJSONL | IssueJSONL | AdrJSONL>(
  filePath: string,
  entityType: EntityType,
  decode: (context: DecodeContext, value: unknown) => T,
  feedbackIds: Set<string>
): T[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  const entities: T[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    const context = { filePath, lineNumber: index + 1 };
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      fail(context, "$", error instanceof Error ? error.message : String(error));
    }
    const entity = decode(context, value);
    validateFeedbackOwnership(context, entityType, entity, feedbackIds);
    entities.push(entity);
  }
  return entities;
}

export function readPersistedSnapshot(
  inputDir: string,
  fileNames: SnapshotFileNames = {}
): EntitySnapshots {
  const feedbackIds = new Set<string>();
  const specFile = fileNames.spec ?? getEntityRow("spec").jsonlFile;
  const issueFile = fileNames.issue ?? getEntityRow("issue").jsonlFile;
  const adrFile = fileNames.adr ?? getEntityRow("adr").jsonlFile;
  return {
    spec: readSnapshotLines(path.join(inputDir, specFile), "spec", decodeSpec, feedbackIds),
    issue: readSnapshotLines(path.join(inputDir, issueFile), "issue", decodeIssue, feedbackIds),
    adr: readSnapshotLines(path.join(inputDir, adrFile), "adr", decodeAdr, feedbackIds),
  };
}

/**
 * Validation utilities for sudocode CLI
 */

import type {
  RelationshipType,
  IssueStatus,
  FeedbackAnchor,
  FeedbackType,
} from "./types.js";
import { InputError } from "@sudocode-ai/types/errors";

/**
 * Valid relationship type values for runtime validation.
 * This mirrors the RelationshipType union type defined in types.ts.
 *
 * Note: TypeScript types are erased at runtime, so we need this runtime
 * set to validate incoming string values. Keep this in sync with the
 * RelationshipType type definition.
 */
const VALID_RELATIONSHIP_TYPES = new Set<RelationshipType>([
  "blocks",
  "related",
  "discovered-from",
  "implements",
  "references",
  "depends-on",
  "supersedes",
]);

export function isValidRelationshipType(type: string): type is RelationshipType {
  return VALID_RELATIONSHIP_TYPES.has(type as RelationshipType);
}

export function getValidRelationshipTypes(): string[] {
  return Array.from(VALID_RELATIONSHIP_TYPES);
}

export function parseRelationshipType(
  value: unknown,
  field = "relationship_type"
): RelationshipType {
  if (typeof value !== "string" || !isValidRelationshipType(value)) {
    throw new InputError(
      field,
      `Invalid relationship type ${String(value)}`,
      getValidRelationshipTypes()
    );
  }
  return value;
}

/**
 * Valid issue status values for runtime validation.
 * This mirrors the IssueStatus union type defined in types.ts.
 */
const VALID_ISSUE_STATUSES = new Set<IssueStatus>([
  "open",
  "in_progress",
  "blocked",
  "needs_review",
  "closed",
]);

export function isValidIssueStatus(status: string): status is IssueStatus {
  return VALID_ISSUE_STATUSES.has(status as IssueStatus);
}

export function getValidIssueStatuses(): string[] {
  return Array.from(VALID_ISSUE_STATUSES);
}

/**
 * Valid feedback type values for runtime validation.
 * This mirrors the FeedbackType union type defined in types.ts.
 */
const VALID_FEEDBACK_TYPES = new Set<FeedbackType>([
  "comment",
  "suggestion",
  "request",
]);

export function isValidFeedbackType(type: string): type is FeedbackType {
  return VALID_FEEDBACK_TYPES.has(type as FeedbackType);
}

type AnchorStatus = FeedbackAnchor["anchor_status"];

const VALID_ANCHOR_STATUSES = [
  "valid",
  "relocated",
  "stale",
] as const satisfies readonly AnchorStatus[];

export function isValidAnchorStatus(value: unknown): value is AnchorStatus {
  return VALID_ANCHOR_STATUSES.some((status) => status === value);
}

export function getValidAnchorStatuses(): string[] {
  return [...VALID_ANCHOR_STATUSES];
}

export function getValidFeedbackTypes(): string[] {
  return Array.from(VALID_FEEDBACK_TYPES);
}

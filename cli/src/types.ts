/**
 * Type definitions for sudocode CLI
 *
 * Core entity types are imported from the main sudocode package.
 */

// Re-export core types from the main package
export type {
  Spec,
  Adr,
  Issue,
  Relationship,
  EntityType,
  RelationshipType,
  IssueStatus,
  Tag,
  Event,
  EventType,
  IssueFeedback,
  LocationAnchor,
  FeedbackAnchor,
  FeedbackType,
  SpecJSONL,
  AdrJSONL,
  IssueJSONL,
  FeedbackJSONL,
  RelationshipJSONL,
  Config,
  // Integration types
  ExternalLink,
  SyncDirection,
  IntegrationProviderName,
} from "@sudocode-ai/types";

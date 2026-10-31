import type { EntityType } from "./index.js";

export interface EntityRow {
  type: EntityType;
  prefix: "s" | "i" | "a";
  table: "specs" | "issues" | "adrs";
  jsonlFile: "specs.jsonl" | "issues.jsonl" | "adrs.jsonl";
  markdownDir: "specs" | "issues" | "adrs";
  command: "spec" | "issue" | "adr";
  toolStem: "spec" | "issue" | "adr";
  route: "specs" | "issues" | "adrs";
  label: "Spec" | "Issue" | "ADR";
  pluralLabel: "Specs" | "Issues" | "ADRs";
}

export const ENTITY_TABLE = {
  spec: {
    type: "spec",
    prefix: "s",
    table: "specs",
    jsonlFile: "specs.jsonl",
    markdownDir: "specs",
    command: "spec",
    toolStem: "spec",
    route: "specs",
    label: "Spec",
    pluralLabel: "Specs",
  },
  issue: {
    type: "issue",
    prefix: "i",
    table: "issues",
    jsonlFile: "issues.jsonl",
    markdownDir: "issues",
    command: "issue",
    toolStem: "issue",
    route: "issues",
    label: "Issue",
    pluralLabel: "Issues",
  },
  adr: {
    type: "adr",
    prefix: "a",
    table: "adrs",
    jsonlFile: "adrs.jsonl",
    markdownDir: "adrs",
    command: "adr",
    toolStem: "adr",
    route: "adrs",
    label: "ADR",
    pluralLabel: "ADRs",
  },
} satisfies Record<EntityType, EntityRow>;

export const ENTITY_ROWS = Object.values(ENTITY_TABLE);

export function isEntityType(value: unknown): value is EntityType {
  return typeof value === "string" && Object.hasOwn(ENTITY_TABLE, value);
}

export function parseEntityType(value: unknown): EntityType {
  if (typeof value !== "string") {
    throw new Error(`Entity type must be a string; received ${typeof value}`);
  }
  const row = ENTITY_ROWS.find((candidate) => candidate.type === value);
  if (!row) throw new Error(`Unknown entity type: ${value}`);
  return row.type;
}

export function getEntityRow(entityType: EntityType): EntityRow {
  return ENTITY_TABLE[entityType];
}

export function getEntityTypeFromPrefix(prefix: string): EntityType {
  const row = ENTITY_ROWS.find((candidate) => candidate.prefix === prefix);
  if (!row) {
    throw new Error(`Unknown entity ID prefix: ${prefix}`);
  }
  return row.type;
}

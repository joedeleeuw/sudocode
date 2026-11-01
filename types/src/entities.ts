import type {
  Adr,
  AdrJSONL,
  Issue,
  IssueJSONL,
  Spec,
  SpecJSONL,
} from "./index.js";
import { InputError } from "./errors.js";

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
} as const;

export type EntityType = keyof typeof ENTITY_TABLE;
export type DocumentEntityType = Exclude<EntityType, "issue">;

interface EntityModels {
  spec: { entity: Spec; snapshot: SpecJSONL };
  issue: { entity: Issue; snapshot: IssueJSONL };
  adr: { entity: Adr; snapshot: AdrJSONL };
}

export type Entity<K extends EntityType = EntityType> = EntityModels[K]["entity"];
export type EntitySnapshot<K extends EntityType = EntityType> = EntityModels[K]["snapshot"];
export type EntitySnapshots = { [K in EntityType]: EntitySnapshot<K>[] };
export type EntitySelection<K extends EntityType = EntityType> = {
  [T in K]: { entityType: T; entity: Entity<T> };
}[K];
export type EntityRow<K extends EntityType = EntityType> = (typeof ENTITY_TABLE)[K];

export const ENTITY_ROWS: readonly EntityRow[] = Object.values(ENTITY_TABLE);
export const ENTITY_TYPE_VALUES: readonly EntityType[] = ENTITY_ROWS.map((row) => row.type);
export const ENTITY_ID_PATTERN_SOURCE = `(?:(?:${ENTITY_ROWS.map((row) => row.prefix).join("|")})-[0-9a-z]{4,8})|(?:(?:${ENTITY_ROWS.map((row) => row.label.toUpperCase()).join("|")})-\\d+)`;

export function isEntityType(value: unknown): value is EntityType {
  return ENTITY_ROWS.some((row) => row.type === value);
}

export function parseEntityType(value: unknown, field = "entity_type"): EntityType {
  if (!isEntityType(value)) {
    throw new InputError(field, `Unknown entity type ${String(value)}`, ENTITY_TYPE_VALUES);
  }
  return value;
}

export function getEntityRow<K extends EntityType>(entityType: K): EntityRow<K> {
  return ENTITY_TABLE[entityType];
}

export function getEntityTypeFromPrefix(prefix: string): EntityType {
  const row = ENTITY_ROWS.find((candidate) => candidate.prefix === prefix);
  if (!row) {
    throw new InputError("entity_id", `Unknown entity ID prefix ${prefix}`, ENTITY_ROWS.map((candidate) => candidate.prefix));
  }
  return row.type;
}

export function getEntityTypeFromId(id: string): EntityType {
  const row = ENTITY_ROWS.find(
    (candidate) =>
      id.startsWith(`${candidate.prefix}-`) ||
      id.startsWith(`${candidate.label.toUpperCase()}-`)
  );
  if (!row) {
    throw new InputError("entity_id", `Cannot infer entity type from ID ${id}`, ENTITY_TYPE_VALUES);
  }
  return row.type;
}

export function isHashID(id: string): boolean {
  const prefix = id.split("-", 1)[0];
  return (
    ENTITY_ROWS.some((row) => row.prefix === prefix) &&
    /^[a-z]-[0-9a-z]{4,8}$/.test(id)
  );
}

export function isLegacyID(id: string): boolean {
  return ENTITY_ROWS.some((row) =>
    new RegExp(`^${row.label.toUpperCase()}-\\d+$`).test(id)
  );
}

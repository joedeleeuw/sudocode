import type { ExternalLink } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(
  row: Record<string, unknown>,
  field: string
): string | undefined {
  const value = row[field];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid external link ${field}: expected a string or null`);
  }
  return value;
}

export function decodeExternalLink(value: unknown): ExternalLink {
  if (!isRecord(value)) {
    throw new Error("Invalid external link: expected an object");
  }
  if (
    typeof value.provider !== "string" ||
    typeof value.external_id !== "string" ||
    typeof value.sync_enabled !== "boolean" ||
    (value.sync_direction !== "inbound" &&
      value.sync_direction !== "outbound" &&
      value.sync_direction !== "bidirectional")
  ) {
    throw new Error("Invalid external link fields");
  }
  const metadata = value.metadata;
  const importMetadata = value.import_metadata;
  if (metadata !== undefined && !isRecord(metadata)) {
    throw new Error("Invalid external link metadata");
  }
  if (importMetadata !== undefined && !isRecord(importMetadata)) {
    throw new Error("Invalid external link import_metadata");
  }
  return {
    provider: value.provider,
    external_id: value.external_id,
    external_url: optionalString(value, "external_url"),
    sync_enabled: value.sync_enabled,
    sync_direction: value.sync_direction,
    last_synced_at: optionalString(value, "last_synced_at"),
    external_updated_at: optionalString(value, "external_updated_at"),
    metadata,
    imported_at: optionalString(value, "imported_at"),
    content_hash: optionalString(value, "content_hash"),
    import_metadata: importMetadata,
  };
}

export function decodeExternalLinks(value: unknown): ExternalLink[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("Invalid external_links: expected an array");
  }
  return value.map(decodeExternalLink);
}

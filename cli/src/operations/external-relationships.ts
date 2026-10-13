import type Database from "better-sqlite3";
import type { ExternalEntity } from "@sudocode-ai/types";
import { listSpecs } from "./specs.js";
import { listIssues } from "./issues.js";
import { addRelationship } from "./relationships.js";

export function importExternalRelationships(
  database: Database.Database,
  source: {
    id: string;
    type: ExternalEntity["type"];
    provider: string;
    entity: ExternalEntity;
  },
) {
  for (const relationship of source.entity.relationships ?? []) {
    const candidates =
      relationship.targetType === "spec"
        ? listSpecs(database)
        : listIssues(database);
    const target = candidates.find((candidate) =>
      candidate.external_links?.some(
        (link) =>
          link.provider === source.provider &&
          link.external_id === relationship.targetId,
      ),
    );
    if (!target) {
      console.warn(
        `${source.entity.id}.relationships.targetId: skipping missing target ${relationship.targetId}`,
      );
      continue;
    }
    addRelationship(database, {
      from_id: source.id,
      from_type: source.type,
      to_id: target.id,
      to_type: relationship.targetType,
      relationship_type: relationship.relationshipType,
    });
  }
}

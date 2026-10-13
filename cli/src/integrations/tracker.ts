import * as path from "path";
import type {
  ExternalEntity,
  ExternalLink,
  Spec,
  Issue,
} from "@sudocode-ai/types";
import { initDatabase } from "../db.js";
import { persistMutation } from "../tracker-mutation.js";
import { TrackerPublicationError } from "../tracker-publication.js";
import {
  createSpec,
  updateSpec,
  getSpec,
  deleteSpec,
} from "../operations/specs.js";
import {
  createIssue,
  updateIssue,
  getIssue,
  deleteIssue,
} from "../operations/issues.js";
import { generateSpecId, generateIssueId } from "../id-generator.js";
import { generateUniqueFilename } from "../filename-generator.js";
import { importExternalRelationships } from "../operations/external-relationships.js";
import type { IntegrationProvider } from "./types.js";

export class IntegrationTracker {
  readonly directory: string;

  constructor(projectPath: string) {
    this.directory = path.join(projectPath, ".sudocode");
  }

  create(
    entity: ExternalEntity,
    mapped: ReturnType<IntegrationProvider["mapToSudocode"]>,
    link: ExternalLink,
  ) {
    const database = initDatabase({
      path: path.join(this.directory, "cache.db"),
    });
    try {
      return persistMutation(database, this.directory, () => {
        const fields = entity.type === "spec" ? mapped.spec : mapped.issue;
        if (!fields)
          throw new TrackerPublicationError(
            this.directory,
            `${entity.id}.${entity.type}`,
            "provider mapping missing",
          );
        const title = fields.title ?? entity.title;
        const content = fields.content ?? entity.description;
        const priority = fields.priority ?? entity.priority;
        const external_links = JSON.stringify([link]);
        const identity =
          entity.type === "spec"
            ? generateSpecId(database, this.directory)
            : generateIssueId(database, this.directory);
        const created =
          entity.type === "spec"
            ? createSpec(database, {
                ...identity,
                title,
                content,
                priority,
                external_links,
                file_path: `specs/${generateUniqueFilename(title, identity.id)}`,
              })
            : createIssue(database, {
                ...identity,
                title,
                content,
                priority,
                external_links,
                status: mapped.issue?.status,
              });
        importExternalRelationships(database, {
          id: created.id,
          type: entity.type,
          provider: link.provider,
          entity,
        });
        return created;
      });
    } finally {
      database.close();
    }
  }

  update(id: string, updates: Partial<Spec | Issue>, externalId?: string) {
    const database = initDatabase({
      path: path.join(this.directory, "cache.db"),
    });
    try {
      return persistMutation(database, this.directory, () => {
        const current = id.startsWith("s-")
          ? getSpec(database, id)
          : getIssue(database, id);
        if (!current)
          throw new TrackerPublicationError(
            this.directory,
            `${id}.id`,
            "entity missing",
          );
        let links = updates.external_links ?? current.external_links;
        if (externalId) {
          if (!links?.some((link) => link.external_id === externalId))
            throw new TrackerPublicationError(
              this.directory,
              `${id}.external_links.external_id`,
              `missing ${externalId}`,
            );
          links = links.map((link) =>
            link.external_id === externalId
              ? { ...link, last_synced_at: new Date().toISOString() }
              : link,
          );
        }
        const fields = {
          ...updates,
          external_links: links ? JSON.stringify(links) : null,
        };
        return id.startsWith("s-")
          ? updateSpec(database, id, fields)
          : updateIssue(database, id, fields);
      });
    } finally {
      database.close();
    }
  }

  delete(id: string) {
    const database = initDatabase({
      path: path.join(this.directory, "cache.db"),
    });
    try {
      return persistMutation(database, this.directory, () => {
        if (id.startsWith("s-")) return deleteSpec(database, id);
        return deleteIssue(database, id);
      });
    } finally {
      database.close();
    }
  }
}

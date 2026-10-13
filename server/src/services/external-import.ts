import type Database from "better-sqlite3";
import type {
  ExternalEntity,
  ExternalComment,
  ExternalLink,
} from "@sudocode-ai/types";
import { createHash } from "crypto";
import { persistMutation } from "@sudocode-ai/cli/dist/tracker-mutation.js";
import {
  createSpec,
  updateSpec,
  listSpecs,
} from "@sudocode-ai/cli/dist/operations/specs.js";
import { listIssues } from "@sudocode-ai/cli/dist/operations/issues.js";
import {
  createFeedback,
  listFeedback,
  deleteFeedback,
} from "@sudocode-ai/cli/dist/operations/feedback.js";
import { addRelationship } from "@sudocode-ai/cli/dist/operations/relationships.js";
import { setTags } from "@sudocode-ai/cli/dist/operations/tags.js";
import { generateSpecId } from "@sudocode-ai/cli/dist/id-generator.js";
import { generateUniqueFilename } from "@sudocode-ai/cli/dist/filename-generator.js";
export interface ExternalImportOptions {
  includeComments?: boolean;
  tags?: string[];
  priority?: number;
  parentId?: string;
}

export function importExternalSpec(
  database: Database.Database,
  directory: string,
  provider: string,
  entity: ExternalEntity,
  comments: ExternalComment[] | undefined,
  options: ExternalImportOptions,
  allowUpdate: boolean,
) {
  return persistMutation(database, directory, () => {
    const existing = listSpecs(database).find((spec) =>
      spec.external_links?.some(
        (link) => link.provider === provider && link.external_id === entity.id,
      ),
    );
    if (existing && !allowUpdate)
      throw new Error(`Already imported: ${entity.id} as ${existing.id}`);
    const now = new Date().toISOString();
    const previousLink = existing?.external_links?.find(
      (link) => link.provider === provider && link.external_id === entity.id,
    );
    const externalLink = {
      provider,
      external_id: entity.id,
      external_url: entity.url,
      sync_enabled: true,
      sync_direction: "inbound",
      last_synced_at: now,
      external_updated_at: entity.updated_at,
      content_hash: createHash("sha256")
        .update(entity.title)
        .update(entity.description ?? "")
        .digest("hex"),
      imported_at: previousLink?.imported_at ?? now,
      import_metadata: {
        imported_by: "api",
        original_status: entity.status,
        original_type: entity.type,
      },
    } satisfies ExternalLink;
    const externalLinks = [
      ...(existing?.external_links ?? []).filter(
        (link) => link.provider !== provider || link.external_id !== entity.id,
      ),
      externalLink,
    ];
    const fields = {
      title: entity.title,
      content: entity.description ?? "",
      priority: options.priority ?? entity.priority ?? existing?.priority ?? 2,
      parent_id: options.parentId,
      external_links: JSON.stringify(externalLinks),
    };
    const identity = existing ?? generateSpecId(database, directory);
    const spec = existing
      ? updateSpec(database, existing.id, fields)
      : createSpec(database, {
          ...identity,
          ...fields,
          file_path: `specs/${generateUniqueFilename(entity.title, identity.id)}`,
        });
    if (options.tags) setTags(database, spec.id, "spec", options.tags);
    for (const relationship of entity.relationships ?? []) {
      const candidates =
        relationship.targetType === "spec"
          ? listSpecs(database)
          : listIssues(database);
      const target = candidates.find((candidate) =>
        candidate.external_links?.some(
          (link) =>
            link.provider === provider &&
            link.external_id === relationship.targetId,
        ),
      );
      if (!target)
        throw new Error(
          `${entity.id}.relationships.targetId: missing ${relationship.targetId}`,
        );
      addRelationship(database, {
        from_id: spec.id,
        from_type: "spec",
        to_id: target.id,
        to_type: relationship.targetType,
        relationship_type: relationship.relationshipType,
      });
    }
    const agent = `import:${provider}:${entity.id}`;
    if (comments) {
      for (const feedback of listFeedback(database, { to_id: spec.id })) {
        if (feedback.agent === agent) deleteFeedback(database, feedback.id);
      }
      for (const comment of comments)
        createFeedback(database, {
          to_id: spec.id,
          feedback_type: "comment",
          content: `**@${comment.author}** commented on ${comment.created_at}:\n\n${comment.body}${comment.url ? `\n\nImported from ${comment.url}` : ""}`,
          agent,
          created_at: comment.created_at,
        });
    }
    return {
      spec,
      externalLink,
      feedbackCount: comments?.length,
      action: existing ? ("updated" as const) : ("created" as const),
    };
  });
}

import type { SpecJSONL, IssueJSONL } from "@sudocode-ai/types";
import { readJSONLSnapshot } from "./jsonl-sync-state.js";
import { TrackerPublicationError } from "./tracker-publication.js";

export function validateReferences(
  specs: ReturnType<typeof readJSONLSnapshot<SpecJSONL>>,
  issues: ReturnType<typeof readJSONLSnapshot<IssueJSONL>>,
) {
  const identities = {
    spec: new Set(specs.entities.map((spec) => spec.id)),
    issue: new Set(issues.entities.map((issue) => issue.id)),
  };
  const feedbackIds = new Set<string>();
  for (const snapshot of [specs, issues]) {
    for (const entity of snapshot.entities) {
      const fail = (field: string, message: string): never => {
        throw new TrackerPublicationError(
          snapshot.filePath,
          `${entity.id}.${field}`,
          message,
        );
      };
      for (const relationship of entity.relationships ?? []) {
        for (const direction of ["from", "to"] as const) {
          const kind = relationship[`${direction}_type`];
          if (
            !(kind in identities) ||
            !identities[kind].has(relationship[direction])
          ) {
            fail(
              `relationships.${direction}`,
              `missing ${kind} ${relationship[direction]}`,
            );
          }
        }
        if (relationship.from !== entity.id)
          fail("relationships.from", "must name the containing entity");
      }
      for (const feedback of entity.feedback ?? []) {
        if (
          !identities.spec.has(feedback.to_id) &&
          !identities.issue.has(feedback.to_id)
        ) {
          fail(
            `feedback.${feedback.id}.to_id`,
            `missing entity ${feedback.to_id}`,
          );
        }
        if (feedback.from_id && !identities.issue.has(feedback.from_id)) {
          fail(
            `feedback.${feedback.id}.from_id`,
            `missing issue ${feedback.from_id}`,
          );
        }
        if ((feedback.from_id || feedback.to_id) !== entity.id) {
          fail(
            `feedback.${feedback.id}.from_id`,
            "feedback must belong to its source issue or anonymous target",
          );
        }
        if (feedbackIds.has(feedback.id))
          fail(`feedback.${feedback.id}.id`, "duplicate feedback");
        feedbackIds.add(feedback.id);
      }
    }
  }
}

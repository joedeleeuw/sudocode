import { persistMutation } from "@sudocode-ai/cli/dist/tracker-mutation.js";
/**
 * Specs API routes (mapped to /api/specs)
 *
 * Note: All routes require X-Project-ID header via requireProject() middleware
 */

import { Router, Request, Response } from "express";
import {
  getAllSpecs,
  getSpecById,
  createNewSpec,
  updateExistingSpec,
  deleteExistingSpec,
} from "../services/specs.js";
import { generateSpecId } from "@sudocode-ai/cli/dist/id-generator.js";
import { generateUniqueFilename } from "@sudocode-ai/cli/dist/filename-generator.js";
import { getSpecFromJsonl } from "@sudocode-ai/cli/dist/operations/external-links.js";
import { broadcastSpecUpdate } from "../services/websocket.js";
import {
  syncEntityToMarkdown,
} from "../services/export.js";
import { refreshSpec } from "../services/external-refresh-service.js";
import * as path from "path";
import * as fs from "fs";

export function createSpecsRouter(): Router {
  const router = Router();

  /**
   * GET /api/specs - List all specs
   */
  router.get("/", (req: Request, res: Response) => {
    try {
      const options: any = {};

      if (req.query.priority) {
        options.priority = parseInt(req.query.priority as string, 10);
      }
      options.archived =
        req.query.archived !== undefined
          ? req.query.archived === "true"
          : false;
      if (req.query.limit) {
        options.limit = parseInt(req.query.limit as string, 10);
      }
      if (req.query.offset) {
        options.offset = parseInt(req.query.offset as string, 10);
      }

      const specs = getAllSpecs(req.project!.db, options);

      res.json({
        success: true,
        data: specs,
      });
    } catch (error) {
      console.error("Error listing specs:", error);
      res.status(500).json({
        success: false,
        data: null,
        error_data: error instanceof Error ? error.message : String(error),
        message: "Failed to list specs",
      });
    }
  });

  /**
   * GET /api/specs/:id - Get a specific spec
   */
  router.get("/:id", (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const spec = getSpecById(req.project!.db, id);

      if (!spec) {
        res.status(404).json({
          success: false,
          data: null,
          message: `Spec not found: ${id}`,
        });
        return;
      }

      res.json({
        success: true,
        data: spec,
      });
    } catch (error) {
      console.error("Error getting spec:", error);
      res.status(500).json({
        success: false,
        data: null,
        error_data: error instanceof Error ? error.message : String(error),
        message: "Failed to get spec",
      });
    }
  });

  /**
   * POST /api/specs - Create a new spec
   */
  router.post("/", async (req: Request, res: Response) => {
    try {
      const { title, content, priority, parent_id } = req.body;

      if (!title || typeof title !== "string") {
        res.status(400).json({
          success: false,
          data: null,
          message: "Title is required and must be a string",
        });
        return;
      }

      if (title.length > 500) {
        res.status(400).json({
          success: false,
          data: null,
          message: "Title must be 500 characters or less",
        });
        return;
      }

      const outputDir = req.project!.sudocodeDir;
      const { id, uuid } = generateSpecId(req.project!.db, outputDir);

      const file_path = `specs/${generateUniqueFilename(title, id)}`;

      const spec = await persistMutation(
        req.project!.db,
        req.project!.sudocodeDir,
        () =>
          createNewSpec(req.project!.db, {
            id,
            uuid,
            title,
            file_path,
            content: content || "",
            priority: priority !== undefined ? priority : 2,
            parent_id: parent_id || undefined,
          })
      );

      syncEntityToMarkdown(
        req.project!.db,
        spec.id,
        "spec",
        req.project!.sudocodeDir
      ).catch((error) => {
        console.error(`Failed to sync spec ${spec.id} to markdown:`, error);
      });

      broadcastSpecUpdate(req.project!.id, spec.id, "created", spec);

      res.status(201).json({
        success: true,
        data: spec,
      });
    } catch (error) {
      console.error("Error creating spec:", error);
      res.status(500).json({
        success: false,
        data: null,
        error_data: error instanceof Error ? error.message : String(error),
        message: "Failed to create spec",
      });
    }
  });

  /**
   * PUT /api/specs/:id - Update an existing spec
   */
  router.put("/:id", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { title, content, priority, parent_id, archived } = req.body;

      if (
        title === undefined &&
        content === undefined &&
        priority === undefined &&
        parent_id === undefined &&
        archived === undefined
      ) {
        res.status(400).json({
          success: false,
          data: null,
          message: "At least one field must be provided for update",
        });
        return;
      }

      if (
        title !== undefined &&
        typeof title === "string" &&
        title.length > 500
      ) {
        res.status(400).json({
          success: false,
          data: null,
          message: "Title must be 500 characters or less",
        });
        return;
      }

      const updateInput: any = {};
      if (title !== undefined) updateInput.title = title;
      if (content !== undefined) updateInput.content = content;
      if (priority !== undefined) updateInput.priority = priority;
      if (parent_id !== undefined) updateInput.parent_id = parent_id;
      if (archived !== undefined) {
        updateInput.archived = archived;
        updateInput.archived_at = archived ? new Date().toISOString() : null;
      }

      const spec = await persistMutation(
        req.project!.db,
        req.project!.sudocodeDir,
        () => updateExistingSpec(req.project!.db, id, updateInput)
      );

      if (req.project!.integrationSyncService) {
        req
          .project!.integrationSyncService.syncEntity(spec.id)
          .catch((error) => {
            console.error(
              `Failed to sync spec ${spec.id} to external integrations:`,
              error
            );
          });
      }

      syncEntityToMarkdown(
        req.project!.db,
        spec.id,
        "spec",
        req.project!.sudocodeDir
      ).catch((error) => {
        console.error(`Failed to sync spec ${spec.id} to markdown:`, error);
      });

      broadcastSpecUpdate(req.project!.id, spec.id, "updated", spec);

      res.json({
        success: true,
        data: spec,
      });
    } catch (error) {
      console.error("Error updating spec:", error);

      if (error instanceof Error && error.message.includes("not found")) {
        res.status(404).json({
          success: false,
          data: null,
          message: error.message,
        });
        return;
      }

      res.status(500).json({
        success: false,
        data: null,
        error_data: error instanceof Error ? error.message : String(error),
        message: "Failed to update spec",
      });
    }
  });

  /**
   * DELETE /api/specs/:id - Delete a spec
   */
  router.delete("/:id", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      const existingSpec = getSpecById(req.project!.db, id);
      if (!existingSpec) {
        res.status(404).json({
          success: false,
          data: null,
          message: `Spec not found: ${id}`,
        });
        return;
      }

      const markdownPath = existingSpec.file_path
        ? path.join(req.project!.sudocodeDir, existingSpec.file_path)
        : null;

      const specFromJsonl = getSpecFromJsonl(req.project!.sudocodeDir, id);
      const externalLinks = specFromJsonl?.external_links || [];

      const deleted = await persistMutation(
        req.project!.db,
        req.project!.sudocodeDir,
        () => deleteExistingSpec(req.project!.db, id)
      );

      if (deleted) {
        if (markdownPath && fs.existsSync(markdownPath)) {
          try {
            fs.unlinkSync(markdownPath);
          } catch (err) {
            console.warn(
              `Failed to delete markdown file: ${markdownPath}`,
              err
            );
          }
        }

        if (externalLinks.length > 0 && req.project!.integrationSyncService) {
          req
            .project!.integrationSyncService.handleEntityDeleted(
              id,
              externalLinks
            )
            .catch((error) => {
              console.error(
                `[specs] Failed to propagate deletion to external systems:`,
                error
              );
            });
        }

        broadcastSpecUpdate(req.project!.id, id, "deleted", { id });

        res.json({
          success: true,
          data: {
            id,
            deleted: true,
          },
        });
      } else {
        res.status(500).json({
          success: false,
          data: null,
          message: "Failed to delete spec",
        });
      }
    } catch (error) {
      console.error("Error deleting spec:", error);
      res.status(500).json({
        success: false,
        data: null,
        error_data: error instanceof Error ? error.message : String(error),
        message: "Failed to delete spec",
      });
    }
  });

  /**
   * POST /api/specs/:id/refresh_from_external - Refresh a spec from its external source
   *
   * Query params:
   * - force=true: Skip conflict check, overwrite local changes
   *
   * Response:
   * - updated: boolean - Whether the entity was updated
   * - hasLocalChanges: boolean - Whether local changes were detected
   * - changes?: Array<{field, localValue, remoteValue}> - Field-level changes (when hasLocalChanges=true)
   * - entity?: Spec - The updated entity (when updated=true)
   */
  router.post("/:id/refresh_from_external", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const force = req.query.force === "true";

      const existingSpec = getSpecById(req.project!.db, id);
      if (!existingSpec) {
        res.status(404).json({
          success: false,
          data: null,
          message: `Spec not found: ${id}`,
        });
        return;
      }


      const result = await refreshSpec(
        req.project!.db,
        req.project!.sudocodeDir,
        req.project!.path,
        id,
        force
      );

      if (result.stale) {
        res.status(200).json({
          success: true,
          data: {
            updated: false,
            hasLocalChanges: false,
            stale: true,
            message: result.error || "External entity no longer exists",
          },
        });
        return;
      }

      if (result.error && !result.hasLocalChanges) {
        res.status(400).json({
          success: false,
          data: null,
          message: result.error,
        });
        return;
      }

      if (result.hasLocalChanges && !result.updated) {
        res.status(200).json({
          success: true,
          data: {
            updated: false,
            hasLocalChanges: true,
            changes: result.changes,
          },
        });
        return;
      }

      if (result.updated && result.entity) {


        syncEntityToMarkdown(
          req.project!.db,
          id,
          "spec",
          req.project!.sudocodeDir
        ).catch((error) => {
          console.error(`Failed to sync spec ${id} to markdown:`, error);
        });

        broadcastSpecUpdate(req.project!.id, id, "updated", result.entity);

        res.status(200).json({
          success: true,
          data: {
            updated: true,
            hasLocalChanges: false,
            entity: result.entity,
          },
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: {
          updated: false,
          hasLocalChanges: false,
        },
      });
    } catch (error) {
      console.error("Error refreshing spec:", error);
      res.status(500).json({
        success: false,
        data: null,
        error_data: error instanceof Error ? error.message : String(error),
        message: "Failed to refresh spec",
      });
    }
  });

  return router;
}

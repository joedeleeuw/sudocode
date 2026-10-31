/**
 * Relationships API routes (mapped to /api/relationships)
 *
 * Note: All routes require X-Project-ID header via requireProject() middleware
 */

import { Router, Request, Response } from "express";
import { parseEntityType } from "@sudocode-ai/types/entities";
import { parseRelationshipType } from "@sudocode-ai/cli/dist/validation.js";
import {
  EntityNotFoundError,
  InvalidRelationshipError,
  RelationshipExistsError,
} from "@sudocode-ai/cli/dist/operations/relationships.js";
import { InputError } from "@sudocode-ai/types/errors";
import {
  createRelationship,
  deleteRelationship,
  getEntityRelationships,
  getAllProjectRelationships,
  getEntityOutgoingRelationships,
  getEntityIncomingRelationships,
} from "../services/relationships.js";
import { broadcastRelationshipUpdate } from "../services/websocket.js";
import { triggerExport } from "../services/export.js";

function sendRelationshipError(
  res: Response,
  error: unknown,
  fallbackMessage: string
): void {
  if (error instanceof InputError) {
    res.status(400).json({
      success: false,
      data: null,
      error_data: { field: error.field, validValues: error.validValues },
      message: error.message,
    });
    return;
  }
  if (error instanceof InvalidRelationshipError) {
    res.status(400).json({ success: false, data: null, message: error.message });
    return;
  }
  if (error instanceof EntityNotFoundError) {
    res.status(404).json({ success: false, data: null, message: error.message });
    return;
  }
  if (error instanceof RelationshipExistsError) {
    res.status(409).json({ success: false, data: null, message: error.message });
    return;
  }
  console.error(fallbackMessage, error);
  res.status(500).json({
    success: false,
    data: null,
    error_data: error instanceof Error ? error.message : String(error),
    message: fallbackMessage,
  });
}

export function createRelationshipsRouter(): Router {
  const router = Router();

  /**
   * GET /api/relationships - Get every relationship in the project
   */
  router.get("/", (req: Request, res: Response) => {
    try {
      res.json({
        success: true,
        data: getAllProjectRelationships(req.project!.db),
      });
    } catch (error) {
      sendRelationshipError(res, error, "Failed to list relationships");
    }
  });

  /**
   * GET /api/relationships/:entity_type/:entity_id - Get all relationships for an entity
   */
  router.get("/:entity_type/:entity_id", (req: Request, res: Response) => {
    try {
      const { entity_type, entity_id } = req.params;

      const relationships = getEntityRelationships(
        req.project!.db,
        entity_id,
        parseEntityType(entity_type, "entity_type")
      );

      res.json({
        success: true,
        data: relationships,
      });
    } catch (error) {
      sendRelationshipError(res, error, "Failed to get relationships");
    }
  });

  /**
   * GET /api/relationships/:entity_type/:entity_id/outgoing - Get outgoing relationships
   */
  router.get(
    "/:entity_type/:entity_id/outgoing",
    (req: Request, res: Response) => {
      try {
        const { entity_type, entity_id } = req.params;
        const { relationship_type } = req.query;

        const parsedEntityType = parseEntityType(entity_type, "entity_type");

        const relationships = getEntityOutgoingRelationships(
          req.project!.db,
          entity_id,
          parsedEntityType,
          relationship_type === undefined
            ? undefined
            : parseRelationshipType(relationship_type, "relationship_type")
        );

        res.json({
          success: true,
          data: relationships,
        });
      } catch (error) {
        sendRelationshipError(res, error, "Failed to get outgoing relationships");
      }
    }
  );

  /**
   * GET /api/relationships/:entity_type/:entity_id/incoming - Get incoming relationships
   */
  router.get(
    "/:entity_type/:entity_id/incoming",
    (req: Request, res: Response) => {
      try {
        const { entity_type, entity_id } = req.params;
        const { relationship_type } = req.query;

        const parsedEntityType = parseEntityType(entity_type, "entity_type");

        const relationships = getEntityIncomingRelationships(
          req.project!.db,
          entity_id,
          parsedEntityType,
          relationship_type === undefined
            ? undefined
            : parseRelationshipType(relationship_type, "relationship_type")
        );

        res.json({
          success: true,
          data: relationships,
        });
      } catch (error) {
        sendRelationshipError(res, error, "Failed to get incoming relationships");
      }
    }
  );

  /**
   * POST /api/relationships - Create a new relationship
   */
  router.post("/", (req: Request, res: Response) => {
    try {
      const {
        from_id,
        from_type,
        to_id,
        to_type,
        relationship_type,
        metadata,
      } = req.body;

      // Validate required fields
      if (!from_id || typeof from_id !== "string") {
        res.status(400).json({
          success: false,
          data: null,
          message: "from_id is required and must be a string",
        });
        return;
      }

      if (!to_id || typeof to_id !== "string") {
        res.status(400).json({
          success: false,
          data: null,
          message: "to_id is required and must be a string",
        });
        return;
      }

      const relationship = createRelationship(req.project!.db, {
        from_id,
        from_type: parseEntityType(from_type, "from_type"),
        to_id,
        to_type: parseEntityType(to_type, "to_type"),
        relationship_type: parseRelationshipType(relationship_type, "relationship_type"),
        metadata: metadata || null,
      });

      // Broadcast relationship creation to WebSocket clients
      broadcastRelationshipUpdate(req.project!.id, "created", relationship);

      // Trigger export to sync JSONL files
      triggerExport(req.project!.db, req.project!.sudocodeDir);

      res.status(201).json({
        success: true,
        data: relationship,
      });
    } catch (error) {
      sendRelationshipError(res, error, "Failed to create relationship");
    }
  });

  /**
   * DELETE /api/relationships - Delete a specific relationship
   */
  router.delete("/", (req: Request, res: Response) => {
    try {
      const { from_id, from_type, to_id, to_type, relationship_type } =
        req.body;

      // Validate required fields
      if (!from_id || typeof from_id !== "string") {
        res.status(400).json({
          success: false,
          data: null,
          message: "from_id is required and must be a string",
        });
        return;
      }

      if (!to_id || typeof to_id !== "string") {
        res.status(400).json({
          success: false,
          data: null,
          message: "to_id is required and must be a string",
        });
        return;
      }

      const deleted = deleteRelationship(
        req.project!.db,
        from_id,
        parseEntityType(from_type, "from_type"),
        to_id,
        parseEntityType(to_type, "to_type"),
        parseRelationshipType(relationship_type, "relationship_type")
      );

      if (deleted) {
        // Broadcast relationship deletion to WebSocket clients
        broadcastRelationshipUpdate(req.project!.id, "deleted", {
          from_id,
          from_type,
          to_id,
          to_type,
          relationship_type,
        });

        // Trigger export to sync JSONL files
        triggerExport(req.project!.db, req.project!.sudocodeDir);

        res.json({
          success: true,
          data: {
            from_id,
            from_type,
            to_id,
            to_type,
            relationship_type,
            deleted: true,
          },
        });
      } else {
        res.status(404).json({
          success: false,
          data: null,
          message: "Relationship not found",
        });
      }
    } catch (error) {
      sendRelationshipError(res, error, "Failed to delete relationship");
    }
  });

  return router;
}

import { Router, Request, Response } from "express";
import type { UpdateAdrInput } from "@sudocode-ai/cli/dist/operations/adrs.js";
import { generateEntityId } from "@sudocode-ai/cli/dist/id-generator.js";
import { generateUniqueFilename } from "@sudocode-ai/cli/dist/filename-generator.js";
import { getEntityRow } from "@sudocode-ai/types/entities";
import {
  createNewAdr,
  deleteExistingAdr,
  getAdrById,
  getAllAdrs,
  updateExistingAdr,
} from "../services/adrs.js";
import {
  executeExportNow,
  syncEntityToMarkdown,
  syncEntityMetadataToMarkdown,
  triggerExport,
} from "../services/export.js";
import { broadcastAdrUpdate } from "../services/websocket.js";
import * as fs from "fs";
import * as path from "path";

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Expected a numeric query value; received ${String(value)}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric query value: ${value}`);
  return parsed;
}

function syncAdr(
  request: Request,
  id: string,
  action: "created" | "updated" | "deleted",
  writeMarkdown: typeof syncEntityToMarkdown = syncEntityToMarkdown
): void {
  const project = request.project!;
  triggerExport(project.db, project.sudocodeDir);
  if (action !== "deleted") {
    writeMarkdown(project.db, id, "adr", project.sudocodeDir).catch(
      (error) => console.error(`Failed to sync ADR ${id} to markdown:`, error)
    );
  }
  const adr = action === "deleted" ? { id } : getAdrById(project.db, id);
  broadcastAdrUpdate(project.id, id, action, adr);
}

export function createAdrsRouter(): Router {
  const router = Router();
  const row = getEntityRow("adr");

  router.get("/", (req: Request, res: Response) => {
    try {
      const archived = req.query.archived !== undefined
        ? req.query.archived === "true"
        : false;
      const adrs = getAllAdrs(req.project!.db, {
        archived,
        limit: optionalNumber(req.query.limit),
        offset: optionalNumber(req.query.offset),
      });
      res.json({ success: true, data: adrs });
    } catch (error) {
      res.status(400).json({
        success: false,
        data: null,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.get("/:id", (req: Request, res: Response) => {
    const adr = getAdrById(req.project!.db, req.params.id);
    if (!adr) {
      res.status(404).json({
        success: false,
        data: null,
        message: `ADR not found: ${req.params.id}`,
      });
      return;
    }
    res.json({ success: true, data: adr });
  });

  router.post("/", async (req: Request, res: Response) => {
    try {
      const { title, content } = req.body;
      if (typeof title !== "string" || title.length === 0 || title.length > 500) {
        res.status(400).json({
          success: false,
          data: null,
          message: "title is required and must contain 1-500 characters",
        });
        return;
      }
      if (content !== undefined && typeof content !== "string") {
        res.status(400).json({
          success: false,
          data: null,
          message: "content must be a string",
        });
        return;
      }
      const project = req.project!;
      const { id, uuid } = generateEntityId(project.db, "adr");
      const filePath = `${row.markdownDir}/${generateUniqueFilename(title, id)}`;
      const adr = createNewAdr(project.db, {
        id,
        uuid,
        title,
        file_path: filePath,
        content: content ?? "",
      });
      await executeExportNow(project.db, project.sudocodeDir);
      syncAdr(req, id, "created");
      res.status(201).json({ success: true, data: adr });
    } catch (error) {
      res.status(500).json({
        success: false,
        data: null,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.put("/:id", async (req: Request, res: Response) => {
    try {
      const { title, content, archived } = req.body;
      if (title === undefined && content === undefined && archived === undefined) {
        res.status(400).json({
          success: false,
          data: null,
          message: "At least one field must be provided for update",
        });
        return;
      }
      if (title !== undefined && (typeof title !== "string" || title.length > 500)) {
        res.status(400).json({
          success: false,
          data: null,
          message: "title must be a string of at most 500 characters",
        });
        return;
      }
      if (content !== undefined && typeof content !== "string") {
        res.status(400).json({
          success: false,
          data: null,
          message: "content must be a string",
        });
        return;
      }
      if (archived !== undefined && typeof archived !== "boolean") {
        res.status(400).json({
          success: false,
          data: null,
          message: "archived must be a boolean",
        });
        return;
      }
      const input: UpdateAdrInput = { title, content, archived };
      const adr = updateExistingAdr(req.project!.db, req.params.id, input);
      await executeExportNow(req.project!.db, req.project!.sudocodeDir);
      syncAdr(
        req,
        req.params.id,
        "updated",
        content === undefined ? syncEntityMetadataToMarkdown : syncEntityToMarkdown
      );
      res.json({ success: true, data: adr });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message.includes("not found") ? 404 : 500).json({
        success: false,
        data: null,
        message,
      });
    }
  });

  router.delete("/:id", async (req: Request, res: Response) => {
    try {
      const project = req.project!;
      const existing = getAdrById(project.db, req.params.id);
      if (!existing) {
        res.status(404).json({
          success: false,
          data: null,
          message: `ADR not found: ${req.params.id}`,
        });
        return;
      }
      const markdownPath = path.join(project.sudocodeDir, existing.file_path);
      deleteExistingAdr(project.db, req.params.id);
      if (fs.existsSync(markdownPath)) fs.unlinkSync(markdownPath);
      await executeExportNow(project.db, project.sudocodeDir);
      syncAdr(req, req.params.id, "deleted");
      res.json({ success: true, data: { id: req.params.id, deleted: true } });
    } catch (error) {
      res.status(500).json({
        success: false,
        data: null,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}

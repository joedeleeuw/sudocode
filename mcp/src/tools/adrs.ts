import { SudocodeClient } from "../client.js";
import type { Adr } from "../types.js";
import { getEntityRow } from "@sudocode-ai/types/entities";

export interface ListAdrsParams {
  limit?: number;
  search?: string;
  archived?: boolean;
}

export interface ShowAdrParams {
  adr_id: string;
}

export interface UpsertAdrParams {
  adr_id?: string;
  title?: string;
  description?: string;
  tags?: string[];
  archived?: boolean;
}

const adrRow = getEntityRow("adr");

export async function listAdrs(
  client: SudocodeClient,
  params: ListAdrsParams = {}
): Promise<Array<Omit<Adr, "content">>> {
  const args = [adrRow.command, "list"];
  if (params.limit !== undefined) args.push("--limit", params.limit.toString());
  if (params.search) args.push("--grep", params.search);
  args.push("--archived", (params.archived ?? false).toString());
  const adrs: unknown = await client.exec(args);
  if (!Array.isArray(adrs)) {
    throw new Error("ADR list returned a non-array response");
  }
  return adrs.map((adr) => {
    if (typeof adr !== "object" || adr === null || !("content" in adr)) {
      throw new Error("ADR list returned an invalid record");
    }
    const { content: _content, ...summary } = adr;
    return summary;
  });
}

export async function showAdr(
  client: SudocodeClient,
  params: ShowAdrParams
): Promise<unknown> {
  return client.exec([adrRow.command, "show", params.adr_id]);
}

export async function upsertAdr(
  client: SudocodeClient,
  params: UpsertAdrParams
): Promise<Adr> {
  if (params.adr_id) {
    const args = [adrRow.command, "update", params.adr_id];
    if (params.title !== undefined) args.push("--title", params.title);
    if (params.description !== undefined) {
      args.push("--description", params.description);
    }
    if (params.tags !== undefined) args.push("--tags", params.tags.join(","));
    if (params.archived !== undefined) {
      args.push("--archived", params.archived.toString());
    }
    return client.exec(args);
  }
  if (!params.title) throw new Error("title is required when creating a new ADR");
  const args = [adrRow.command, "create", params.title];
  if (params.description !== undefined) {
    args.push("--description", params.description);
  }
  if (params.tags !== undefined) args.push("--tags", params.tags.join(","));
  return client.exec(args);
}

export function decodeListAdrsParams(
  args: Record<string, unknown>
): ListAdrsParams {
  if (args.limit !== undefined && typeof args.limit !== "number") {
    throw new Error("limit must be a number");
  }
  if (args.search !== undefined && typeof args.search !== "string") {
    throw new Error("search must be a string");
  }
  if (args.archived !== undefined && typeof args.archived !== "boolean") {
    throw new Error("archived must be a boolean");
  }
  return { limit: args.limit, search: args.search, archived: args.archived };
}

export function decodeShowAdrParams(
  args: Record<string, unknown>
): ShowAdrParams {
  if (typeof args.adr_id !== "string") {
    throw new Error("adr_id is required and must be a string");
  }
  return { adr_id: args.adr_id };
}

export function decodeUpsertAdrParams(
  args: Record<string, unknown>
): UpsertAdrParams {
  if (args.adr_id !== undefined && typeof args.adr_id !== "string") {
    throw new Error("adr_id must be a string");
  }
  if (args.title !== undefined && typeof args.title !== "string") {
    throw new Error("title must be a string");
  }
  if (args.description !== undefined && typeof args.description !== "string") {
    throw new Error("description must be a string");
  }
  if (
    args.tags !== undefined &&
    (!Array.isArray(args.tags) || args.tags.some((tag) => typeof tag !== "string"))
  ) {
    throw new Error("tags must be an array of strings");
  }
  if (args.archived !== undefined && typeof args.archived !== "boolean") {
    throw new Error("archived must be a boolean");
  }
  return {
    adr_id: args.adr_id,
    title: args.title,
    description: args.description,
    tags: args.tags,
    archived: args.archived,
  };
}

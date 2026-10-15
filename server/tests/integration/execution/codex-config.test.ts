/**
 * Integration test for the Codex launch command
 *
 * Applies a Codex execution config through the real handler, launches the
 * registered agent through acp-factory with a stub `npx` on PATH that records
 * its argv, and checks the `-c` overrides codex-acp would receive.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { AgentFactory } from "acp-factory";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { processAgentConfig } from "../../../src/execution/executors/agent-config-handlers.js";

let stubDir: string;
let argvFile: string;
let originalPath: string | undefined;

describe("Codex launch command", () => {
  beforeAll(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "sudocode-codex-config-"));
    argvFile = path.join(stubDir, "argv");
    fs.writeFileSync(
      path.join(stubDir, "npx"),
      `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg"; done > "${argvFile}.partial"\nmv "${argvFile}.partial" "${argvFile}"\n`,
      { mode: 0o755 }
    );
    originalPath = process.env.PATH;
    process.env.PATH = `${stubDir}${path.delimiter}${originalPath}`;
  });

  afterAll(() => {
    process.env.PATH = originalPath;
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  it("passes approval, sandbox, model and configOverrides as -c values, overrides last", async () => {
    processAgentConfig(
      "codex",
      {
        model: "gpt-test",
        agentConfig: {
          fullAuto: true,
          configOverrides: {
            model_reasoning_effort: "high",
            "sandbox_workspace_write.writable_roots": '["/repo/.git"]',
            sandbox_mode: "read-only",
          },
        },
      },
      { workDir: stubDir }
    );

    void AgentFactory.spawn("codex").catch(() => {});
    await vi.waitFor(() => expect(fs.existsSync(argvFile)).toBe(true));

    expect(fs.readFileSync(argvFile, "utf8").trim().split("\n")).toEqual([
      "@zed-industries/codex-acp",
      "-c",
      "approval_policy=on-request",
      "-c",
      "sandbox_mode=read-only",
      "-c",
      "model=gpt-test",
      "-c",
      "model_reasoning_effort=high",
      "-c",
      'sandbox_workspace_write.writable_roots=["/repo/.git"]',
    ]);
  });
});

/**
 * Integration Tests for failed persistent sessions
 *
 * Runs a real stub ACP agent whose prompt fails through the real executor
 * wrapper and checks that ending the session, after or during failure
 * handling, never marks the failed execution completed.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AgentFactory } from "acp-factory";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AcpExecutorWrapper } from "../../../src/execution/executors/acp-executor-wrapper.js";
import { registerExecutionCallback } from "../../../src/services/execution-event-callbacks.js";
import {
  createTestDatabase,
  createTestServices,
  createTestTask,
  createExecution,
  getExecution,
} from "./helpers/test-setup.js";

const AGENT_TYPE = "stub-failing-prompt";

/** ACP stub that completes the handshake and fails every prompt */
const ACP_STUB = `
const reply = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
let buffered = "";
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffered.slice(0, newline));
    buffered = buffered.slice(newline + 1);
    if (message.method === "initialize") reply({ id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities: {} } });
    if (message.method === "session/new") reply({ id: message.id, result: { sessionId: "stub-session" } });
    if (message.method === "session/prompt") reply({ id: message.id, error: { code: -32603, message: "stub prompt failure" } });
  }
});
`;

let stubDir: string;

async function runFailingPersistentExecution(
  executionId: string,
  onFailed: (wrapper: AcpExecutorWrapper) => Promise<void>
) {
  const db = createTestDatabase();
  const { lifecycleService, logsStore } = createTestServices(db);
  createExecution(db, { id: executionId, agent_type: AGENT_TYPE, status: "pending" });
  const wrapper = new AcpExecutorWrapper({
    agentType: AGENT_TYPE,
    acpConfig: { agentType: AGENT_TYPE, permissionMode: "auto-approve" },
    lifecycleService,
    logsStore,
    projectId: "test-project",
    db,
  });
  const events: string[] = [];
  const unregister = registerExecutionCallback(async (event, data) => {
    if (data.executionId !== executionId) return;
    events.push(event);
    if (event === "failed") await onFailed(wrapper);
  });

  try {
    await expect(
      wrapper.executeWithLifecycle(
        executionId,
        createTestTask({ id: executionId, workDir: stubDir }),
        stubDir,
        { sessionMode: "persistent" }
      )
    ).rejects.toThrow("stub prompt failure");
    await wrapper.endSession(executionId);
    return { execution: getExecution(db, executionId), events, wrapper };
  } finally {
    unregister();
    db.close();
  }
}

describe("Failed persistent session", () => {
  beforeAll(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "sudocode-persistent-failure-"));
    const acpStub = path.join(stubDir, "acp-stub.cjs");
    fs.writeFileSync(acpStub, ACP_STUB);
    AgentFactory.register(AGENT_TYPE, {
      command: process.execPath,
      args: [acpStub],
      env: {},
    });
  });

  afterAll(() => {
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  it("stays failed when the session is ended after the failure", async () => {
    const { execution, events, wrapper } = await runFailingPersistentExecution(
      "exec-end-after-failure",
      async () => {}
    );

    expect(execution.status).toBe("failed");
    expect(execution.exit_code).toBeNull();
    expect(events).toEqual(["failed"]);
    expect(wrapper.isPersistentSession("exec-end-after-failure")).toBe(false);
  });

  it("stays failed when the session is ended while the failure is recorded", async () => {
    const { execution, events } = await runFailingPersistentExecution(
      "exec-end-during-failure",
      (wrapper) => wrapper.endSession("exec-end-during-failure")
    );

    expect(execution.status).toBe("failed");
    expect(execution.exit_code).toBeNull();
    expect(events).toEqual(["failed"]);
  });
});

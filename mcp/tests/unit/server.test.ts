/**
 * Unit tests for scope-based tool filtering
 */

import { describe, it, expect } from "vitest";
import { getToolsForScopes } from "../../src/tool-registry.js";
import { expandScopes, getUsableScopes } from "../../src/scopes.js";

describe("Scope-based tool filtering", () => {
  describe("default scope", () => {
    it("provides only CLI-wrapped tools without server URL", () => {
      const enabledScopes = expandScopes(["default"]);
      const usableScopes = getUsableScopes(enabledScopes, undefined);
      const tools = getToolsForScopes(usableScopes);

      expect(tools).toHaveLength(10);
      expect(tools.map((t) => t.name)).toContain("ready");
      expect(tools.map((t) => t.name)).toContain("list_issues");
      expect(tools.map((t) => t.name)).not.toContain("list_executions");
    });
  });

  describe("extended scopes without server URL", () => {
    it("filters out extended scopes when server URL is not provided", () => {
      const enabledScopes = expandScopes(["default", "executions"]);
      const usableScopes = getUsableScopes(enabledScopes, undefined);
      const tools = getToolsForScopes(usableScopes);

      // Only default tools should be available
      expect(tools).toHaveLength(10);
      expect(tools.every((t) => t.scope === "default")).toBe(true);
    });
  });

  describe("extended scopes with server URL", () => {
    it("includes execution tools when server URL is provided", () => {
      const enabledScopes = expandScopes(["default", "executions"]);
      const usableScopes = getUsableScopes(enabledScopes, "http://localhost:3000");
      const tools = getToolsForScopes(usableScopes);

      const names = tools.map((t) => t.name);
      expect(names).toContain("ready"); // default
      expect(names).toContain("list_executions"); // executions:read
      expect(names).toContain("start_execution"); // executions:write
    });

    it("includes inspection tools when server URL is provided", () => {
      const enabledScopes = expandScopes(["inspection"]);
      const usableScopes = getUsableScopes(enabledScopes, "http://localhost:3000");
      const tools = getToolsForScopes(usableScopes);

      const names = tools.map((t) => t.name);
      // Note: execution_trajectory is disabled (not yet implemented)
      expect(names).toContain("execution_changes");
      expect(names).toContain("execution_chain");
    });

    it("includes workflow tools when server URL is provided", () => {
      const enabledScopes = expandScopes(["workflows"]);
      const usableScopes = getUsableScopes(enabledScopes, "http://localhost:3000");
      const tools = getToolsForScopes(usableScopes);

      const names = tools.map((t) => t.name);
      expect(names).toContain("list_workflows");
      expect(names).toContain("create_workflow");
      expect(names).toContain("start_workflow");
    });

    it("includes overview tools when server URL is provided", () => {
      const enabledScopes = expandScopes(["overview"]);
      const usableScopes = getUsableScopes(enabledScopes, "http://localhost:3000");
      const tools = getToolsForScopes(usableScopes);

      expect(tools.map((t) => t.name)).toContain("project_status");
    });
  });

  describe("project-assistant meta-scope", () => {
    it("expands to all assistant-related scopes", () => {
      const enabledScopes = expandScopes(["project-assistant"]);

      expect(enabledScopes.has("overview")).toBe(true);
      expect(enabledScopes.has("executions")).toBe(true);
      expect(enabledScopes.has("executions:read")).toBe(true);
      expect(enabledScopes.has("executions:write")).toBe(true);
      expect(enabledScopes.has("inspection")).toBe(true);
      expect(enabledScopes.has("workflows")).toBe(true);
      expect(enabledScopes.has("workflows:read")).toBe(true);
      expect(enabledScopes.has("workflows:write")).toBe(true);
      // Default is NOT included in project-assistant
      expect(enabledScopes.has("default")).toBe(false);
    });

    it("provides all extended tools when server URL is provided", () => {
      const enabledScopes = expandScopes(["project-assistant"]);
      const usableScopes = getUsableScopes(enabledScopes, "http://localhost:3000");
      const tools = getToolsForScopes(usableScopes);

      const names = tools.map((t) => t.name);

      // Overview tools
      expect(names).toContain("project_status");

      // Execution tools
      expect(names).toContain("list_executions");
      expect(names).toContain("show_execution");
      expect(names).toContain("start_execution");
      expect(names).toContain("cancel_execution");

      // Inspection tools (note: execution_trajectory is disabled)
      expect(names).toContain("execution_changes");
      expect(names).toContain("execution_chain");

      // Workflow tools
      expect(names).toContain("list_workflows");
      expect(names).toContain("create_workflow");

      // Should NOT include default tools
      expect(names).not.toContain("ready");
      expect(names).not.toContain("list_issues");
    });
  });

  describe("all meta-scope", () => {
    it("expands to all scopes including default", () => {
      const enabledScopes = expandScopes(["all"]);

      expect(enabledScopes.has("default")).toBe(true);
      expect(enabledScopes.has("overview")).toBe(true);
      expect(enabledScopes.has("executions")).toBe(true);
      expect(enabledScopes.has("inspection")).toBe(true);
      expect(enabledScopes.has("workflows")).toBe(true);
    });

    it("provides all tools when server URL is provided", () => {
      const enabledScopes = expandScopes(["all"]);
      const usableScopes = getUsableScopes(enabledScopes, "http://localhost:3000");
      const tools = getToolsForScopes(usableScopes);

      const names = tools.map((t) => t.name);

      // Default tools
      expect(names).toContain("ready");
      expect(names).toContain("list_issues");

      // Extended tools (note: execution_trajectory is disabled)
      expect(names).toContain("project_status");
      expect(names).toContain("list_executions");
      expect(names).toContain("list_workflows");
    });

    it("only provides default tools when server URL is not provided", () => {
      const enabledScopes = expandScopes(["all"]);
      const usableScopes = getUsableScopes(enabledScopes, undefined);
      const tools = getToolsForScopes(usableScopes);

      // Only default tools should be available
      expect(tools).toHaveLength(10);
      expect(tools.every((t) => t.scope === "default")).toBe(true);
    });
  });

  describe("granular scopes", () => {
    it("allows executions:read without executions:write", () => {
      const enabledScopes = expandScopes(["executions:read"]);
      const usableScopes = getUsableScopes(enabledScopes, "http://localhost:3000");
      const tools = getToolsForScopes(usableScopes);

      const names = tools.map((t) => t.name);
      expect(names).toContain("list_executions");
      expect(names).toContain("show_execution");
      expect(names).not.toContain("start_execution");
      expect(names).not.toContain("cancel_execution");
    });

    it("allows workflows:read without workflows:write", () => {
      const enabledScopes = expandScopes(["workflows:read"]);
      const usableScopes = getUsableScopes(enabledScopes, "http://localhost:3000");
      const tools = getToolsForScopes(usableScopes);

      const names = tools.map((t) => t.name);
      expect(names).toContain("list_workflows");
      expect(names).toContain("show_workflow");
      expect(names).toContain("workflow_status");
      expect(names).not.toContain("create_workflow");
      expect(names).not.toContain("start_workflow");
    });
  });
});

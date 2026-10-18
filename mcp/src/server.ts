/**
 * MCP Server for sudocode
 *
 * This module sets up the MCP server with tools and resources.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SudocodeClient } from "./client.js";
import * as issueTools from "./tools/issues.js";
import * as specTools from "./tools/specs.js";
import * as relationshipTools from "./tools/relationships.js";
import * as feedbackTools from "./tools/feedback.js";
import * as referenceTools from "./tools/references.js";
import { SudocodeMCPServerConfig } from "./types.js";
import { isAbsolute, join } from "path";
import {
  type Scope,
  type ScopeConfig,
  resolveScopes,
  getUsableScopes,
  hasExtendedScopes,
} from "./scopes.js";
import { SudocodeAPIClient } from "./api-client.js";
import {
  getToolsForScopes as getToolDefsForScopes,
  getToolByName,
  getHandlerType,
} from "./tool-registry.js";

export class SudocodeMCPServer {
  private server: Server;
  private client: SudocodeClient;
  private apiClient: SudocodeAPIClient | null = null;
  private config: SudocodeMCPServerConfig;
  private scopeConfig: ScopeConfig;
  private usableScopes: Set<Scope>;
  private projectClients = new Map<string, SudocodeClient>();

  constructor(config?: SudocodeMCPServerConfig) {
    this.config = config || {};

    // Resolve scopes from config
    const scopeArg = this.config.scope || "default";
    this.scopeConfig = resolveScopes(
      scopeArg,
      this.config.serverUrl,
      this.config.projectId
    );

    // Determine which scopes are actually usable (have prerequisites met)
    this.usableScopes = getUsableScopes(
      this.scopeConfig.enabledScopes,
      this.config.serverUrl
    );

    // Create API client if server URL is configured and extended scopes are enabled
    if (this.config.serverUrl && hasExtendedScopes(this.usableScopes)) {
      if (process.env.DEBUG_MCP) {
        console.error(`[SudocodeMCPServer] Creating API client with projectId=${this.config.projectId}`);
      }
      this.apiClient = new SudocodeAPIClient({
        serverUrl: this.config.serverUrl,
        projectId: this.config.projectId,
      });
    }

    this.server = new Server(
      {
        name: "sudocode",
        version: "0.1.1",
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    this.client = new SudocodeClient(config);
    this.setupHandlers();
  }

  private setupHandlers() {
    // List available tools - filtered by usable scopes
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const availableTools = getToolDefsForScopes(this.usableScopes);
      return {
        tools: availableTools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      };
    });

    // Handle tool calls - route to CLI or API based on tool scope
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      // Get tool definition
      const tool = getToolByName(name);
      if (!tool) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown tool: ${name}`,
            },
          ],
          isError: true,
        };
      }

      // Check if tool is in enabled scopes
      if (!this.usableScopes.has(tool.scope)) {
        return {
          content: [
            {
              type: "text",
              text: `Tool '${name}' is not available. Scope '${tool.scope}' is not enabled or missing prerequisites (--server-url).`,
            },
          ],
          isError: true,
        };
      }

      const handlerType = getHandlerType(tool);

      try {
        let result: unknown;

        if (handlerType === "cli") {
          // Route to CLI handlers (default scope)
          result = await this.handleCliTool(name, args as Record<string, unknown>);
        } else {
          // Route to API handlers (extended scopes)
          result = await this.handleApiTool(name, args as Record<string, unknown>);
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        let errorText = `Error: ${
          error instanceof Error ? error.message : String(error)
        }`;

        // Include stderr if this is a sudocode error
        if (error instanceof Error && "stderr" in error && error.stderr) {
          errorText += `\n\nStderr:\n${error.stderr}`;
        }

        return {
          content: [
            {
              type: "text",
              text: errorText,
            },
          ],
          isError: true,
        };
      }
    });

    // List available resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return {
        resources: [
          {
            uri: "sudocode://quickstart",
            name: "sudocode Quickstart Guide",
            description:
              "Introduction to sudocode workflow and best practices for agents",
            mimeType: "text/markdown",
          },
        ],
      };
    });

    // Read resource content
    this.server.setRequestHandler(
      ReadResourceRequestSchema,
      async (request) => {
        const { uri } = request.params;

        if (uri === "sudocode://quickstart") {
          return {
            contents: [
              {
                uri,
                mimeType: "text/markdown",
                text: `# sudocode Quickstart

sudocode is a git-native spec and issue management system designed for AI-assisted development.

## Core Concepts

**Specs**: Technical specifications stored as markdown files
- Types: architecture, api, database, feature, research
- Status: draft → review → approved → deprecated
- Each spec has a unique hash-based ID (e.g., s-14sh) and file path

**Issues**: Work items tracked in the database
- Types: bug, feature, task, epic, chore
- Status: open → in_progress → blocked → closed
- Can reference and implement specs
- Each issue has a unique hash-based ID (e.g., i-x7k9)

**Feedback**: Issues can provide anchored feedback on specs
- Anchors track specific lines/sections in spec markdown
- Auto-relocates when specs change (smart anchoring)
- Types: comment, suggestion, request

## Typical Workflow

1. **Check ready work**: \`ready\` tool to find tasks with no blockers
2. **Claim work**: \`update_issue\` with status=in_progress
3. **Review specs**: \`show_spec\` to understand requirements
4. **Provide feedback**: \`add_feedback\` when specs are unclear
5. **Complete work**: \`close_issue\` when done
6. **Link entities**: Use \`link\` to create relationships

## Relationship Types
- \`blocks\`: Hard blocker (to_id must complete before from_id)
- \`implements\`: Issue implements a spec
- \`references\`: Soft reference
- \`depends-on\`: General dependency
- \`discovered-from\`: New work found during implementation
- \`related\`: General relationship
`,
              },
            ],
          };
        }

        throw new Error(`Unknown resource: ${uri}`);
      }
    );
  }

  /**
   * Handle CLI-based tools (default scope).
   */
  private async handleCliTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const { project, ...toolArgs } = args;
    const client = this.clientFor(project);
    switch (name) {
      case "ready":
        return issueTools.ready(client, toolArgs as any);
      case "list_issues":
        return issueTools.listIssues(client, toolArgs as any);
      case "show_issue":
        return issueTools.showIssue(client, toolArgs as any);
      case "upsert_issue":
        return issueTools.upsertIssue(client, toolArgs as any);
      case "list_specs":
        return specTools.listSpecs(client, toolArgs as any);
      case "show_spec":
        return specTools.showSpec(client, toolArgs as any);
      case "upsert_spec":
        return specTools.upsertSpec(client, toolArgs as any);
      case "link":
        return relationshipTools.link(client, toolArgs as any);
      case "add_reference":
        return referenceTools.addReference(client, toolArgs as any);
      case "add_feedback":
        return feedbackTools.addFeedback(client, toolArgs as any);
      default:
        throw new Error(`Unknown CLI tool: ${name}`);
    }
  }

  /**
   * The CLI client for a tool call's project: the server's working directory
   * when the call names none, otherwise one client per project path.
   */
  private clientFor(project: unknown): SudocodeClient {
    if (project === undefined) {
      return this.client;
    }
    if (typeof project !== "string" || !isAbsolute(project)) {
      throw new Error(
        `project must be an absolute path inside a git repository, got ${JSON.stringify(project)}`
      );
    }
    const pinnedDatabase = this.config.dbPath ?? process.env.SUDOCODE_DB;
    if (pinnedDatabase) {
      throw new Error(
        `project ${project} cannot be used: this server is pinned to the database ${pinnedDatabase}`
      );
    }
    const existing = this.projectClients.get(project);
    if (existing) {
      return existing;
    }
    const client = new SudocodeClient({ ...this.config, workingDir: project });
    this.projectClients.set(project, client);
    return client;
  }

  /**
   * Handle API-based tools (extended scopes).
   */
  private async handleApiTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    if (!this.apiClient) {
      throw new Error(
        `Tool '${name}' requires --server-url to be configured.`
      );
    }

    switch (name) {
      // Overview
      case "project_status":
        return this.apiClient.getProjectStatus();

      // Executions
      case "list_executions":
        return this.apiClient.listExecutions(args as any);
      case "show_execution":
        return this.apiClient.showExecution(args as any);
      case "start_execution":
        return this.apiClient.startExecution(args as any);
      case "start_adhoc_execution":
        return this.apiClient.startAdhocExecution(args as any);
      case "create_follow_up":
        return this.apiClient.createFollowUp(args as any);
      case "cancel_execution":
        return this.apiClient.cancelExecution(args as any);

      // Inspection
      // TODO: execution_trajectory - not yet implemented (see tool-registry.ts)
      case "execution_changes":
        return this.apiClient.getExecutionChanges(args as any);
      case "execution_chain":
        return this.apiClient.getExecutionChain(args as any);

      // Workflows
      case "list_workflows":
        return this.apiClient.listWorkflows(args as any);
      case "show_workflow":
        return this.apiClient.showWorkflow(args as any);
      case "workflow_status":
        return this.apiClient.getWorkflowStatus(args as any);
      case "create_workflow":
        return this.apiClient.createWorkflow(args as any);
      case "start_workflow":
        return this.apiClient.startWorkflow(args as any);
      case "pause_workflow":
        return this.apiClient.pauseWorkflow(args as any);
      case "cancel_workflow":
        return this.apiClient.cancelWorkflow(args as any);
      case "resume_workflow":
        return this.apiClient.resumeWorkflow(args as any);

      // Voice - speak is a no-op on the MCP side; actual narration
      // happens server-side when parsing the agent's output stream
      case "speak":
        return { success: true, message: "Narration queued" };

      default:
        throw new Error(`Unknown API tool: ${name}`);
    }
  }

  async run() {
    // Log scope configuration
    const enabledScopesList = Array.from(this.usableScopes).join(", ");
    const availableTools = getToolDefsForScopes(this.usableScopes);
    console.error(`✓ Enabled scopes: ${enabledScopesList}`);
    console.error(`✓ Available tools: ${availableTools.length}`);

    if (this.config.serverUrl) {
      console.error(`✓ Server URL: ${this.config.serverUrl}`);
    }

    // Auto-open project on server if we have an API client and working directory
    if (this.apiClient && this.config.workingDir) {
      try {
        const workingDir = this.config.workingDir;
        const absolutePath = workingDir.startsWith("/")
          ? workingDir
          : join(process.cwd(), workingDir);

        console.error(`[mcp] Opening project at ${absolutePath}...`);
        const result = await this.apiClient.openProject(absolutePath);
        console.error(`✓ Project opened: ${result.id}`);

        // Update projectId if it was auto-discovered differently
        if (result.id !== this.config.projectId) {
          console.error(`[mcp] Note: Server returned project ID ${result.id} (was: ${this.config.projectId})`);
        }
      } catch (error) {
        // Log but don't fail - project might already be open or server might not be running
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[mcp] Warning: Could not open project on server: ${message}`);
      }
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("sudocode MCP server running on stdio");
  }
}

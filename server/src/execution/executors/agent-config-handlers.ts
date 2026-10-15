/**
 * Agent Configuration Handlers
 *
 * Encapsulates agent-specific configuration logic for ACP executors.
 * Each agent may have different requirements for:
 * - Environment variable mappings (e.g., model selection)
 * - Permission handling modes
 * - CLI argument generation
 * - Session mode settings
 *
 * @module execution/executors/agent-config-handlers
 */

import { AgentFactory } from "acp-factory";
import type { PermissionMode, McpServer } from "acp-factory";
import type { CodexConfig } from "@sudocode-ai/types/agents";
import type { SudocodeMcpServersConfig } from "./acp-executor-wrapper.js";
import { AgentConfigValidationError } from "../../errors/agent-errors.js";

/**
 * Codex options in the raw config (the frontend sends them in agentConfig)
 */
type CodexOptions = Pick<
  CodexConfig,
  "fullAuto" | "sandbox" | "askForApproval" | "configOverrides"
>;

/**
 * Raw agent configuration from the frontend/API
 */
export interface RawAgentConfig extends CodexOptions {
  model?: string;
  env?: Record<string, string>;
  mode?: string;
  dangerouslySkipPermissions?: boolean;
  permissionMode?: string;
  mcpServers?: SudocodeMcpServersConfig | McpServer[];
  agentConfig?: CodexOptions & {
    model?: string;
    env?: Record<string, string>;
    mode?: string;
    dangerouslySkipPermissions?: boolean;
    permissionMode?: string;
  };
}

/**
 * Processed agent configuration ready for ACP executor
 */
export interface ProcessedAgentConfig {
  /** Merged environment variables including model mappings */
  env?: Record<string, string>;
  /** ACP protocol permission mode (auto-approve, interactive, etc.) */
  acpPermissionMode: PermissionMode;
  /** Whether to skip all permission checks */
  skipPermissions: boolean;
  /** Agent-specific permission mode (for agents that support setMode) */
  agentPermissionMode?: string;
  /** Session mode (code, plan, ask, architect) */
  sessionMode?: string;
  /** MCP servers configuration */
  mcpServers?: SudocodeMcpServersConfig | McpServer[];
  /** Compaction configuration for automatic context management */
  compaction?: {
    enabled: boolean;
    contextTokenThreshold?: number;
    customInstructions?: string;
  };
}

/**
 * Context for agent configuration processing
 */
export interface AgentConfigContext {
  /** Whether this is a resume/follow-up execution */
  isResume?: boolean;
  /** Working directory for the execution */
  workDir: string;
  /** Session ID to resume (for agents that support --resume <sessionId>) */
  sessionId?: string;
}

/**
 * Handler interface for agent-specific configuration
 */
export interface AgentConfigHandler {
  /**
   * Process raw agent configuration into executor-ready format
   */
  processConfig(
    rawConfig: RawAgentConfig,
    context: AgentConfigContext
  ): ProcessedAgentConfig;

  /**
   * Reject config this agent cannot launch with. Runs when an execution is
   * requested, before its record or worktree exists.
   *
   * @throws AgentConfigValidationError
   */
  checkConfig?(rawConfig: RawAgentConfig): void;

  /**
   * Apply any agent-specific setup (e.g., dynamic registration)
   * Called before spawning the agent
   */
  applySetup?(
    rawConfig: RawAgentConfig,
    processedConfig: ProcessedAgentConfig,
    context: AgentConfigContext
  ): void;

  /**
   * Get the session mode to set after session creation
   * Returns the mode string to pass to session.setMode(), or undefined to skip
   */
  getSessionPermissionMode?(
    processedConfig: ProcessedAgentConfig
  ): string | undefined;
}

// =============================================================================
// Claude Code Handler
// =============================================================================

/**
 * Configuration handler for Claude Code agent
 *
 * Handles:
 * - ANTHROPIC_MODEL environment variable
 * - Permission modes: default, plan, bypassPermissions, acceptEdits
 * - dangerouslySkipPermissions toggle
 */
export const claudeCodeHandler: AgentConfigHandler = {
  processConfig(
    rawConfig: RawAgentConfig,
    _context: AgentConfigContext
  ): ProcessedAgentConfig {
    // Build model environment variable
    const modelEnvVars: Record<string, string> = {};
    const model = rawConfig.model || rawConfig.agentConfig?.model;
    if (model && model !== "default") {
      modelEnvVars.ANTHROPIC_MODEL = model;
    }

    // Merge environment variables
    const existingEnv = rawConfig.env || rawConfig.agentConfig?.env;
    const env =
      Object.keys(modelEnvVars).length > 0 || existingEnv
        ? { ...modelEnvVars, ...existingEnv }
        : undefined;

    // Check for dangerouslySkipPermissions toggle
    const dangerouslySkipPermissions =
      rawConfig.dangerouslySkipPermissions === true ||
      rawConfig.agentConfig?.dangerouslySkipPermissions === true;

    // Check for permissionMode setting
    const permissionMode =
      rawConfig.permissionMode || rawConfig.agentConfig?.permissionMode;

    // Skip permissions if either toggle is on or mode is bypassPermissions
    const skipPermissions =
      dangerouslySkipPermissions || permissionMode === "bypassPermissions";

    // Session mode (code, plan, ask, architect)
    const sessionMode = rawConfig.mode || rawConfig.agentConfig?.mode;

    // Extract compaction configuration
    const agentConfig = rawConfig.agentConfig || rawConfig;
    const compaction = (
      agentConfig as {
        compaction?: {
          enabled?: boolean;
          contextTokenThreshold?: number;
          customInstructions?: string;
        };
      }
    ).compaction;

    return {
      env,
      acpPermissionMode: skipPermissions ? "auto-approve" : "interactive",
      skipPermissions,
      agentPermissionMode: permissionMode,
      sessionMode,
      mcpServers: rawConfig.mcpServers,
      compaction: compaction?.enabled
        ? {
            enabled: true,
            contextTokenThreshold: compaction.contextTokenThreshold,
            customInstructions: compaction.customInstructions,
          }
        : undefined,
    };
  },

  getSessionPermissionMode(
    processedConfig: ProcessedAgentConfig
  ): string | undefined {
    // If explicit permission mode is set, use it
    if (processedConfig.agentPermissionMode) {
      return processedConfig.agentPermissionMode;
    }

    // If skip permissions is enabled (via toggle), use bypassPermissions
    if (processedConfig.skipPermissions) {
      return "bypassPermissions";
    }

    // Explicitly set "default" mode to ensure interactive permissions
    // Claude Code ACP may have different defaults, so we set it explicitly
    return "default";
  },
};

// =============================================================================
// Gemini Handler
// =============================================================================

/**
 * Configuration handler for Gemini CLI agent
 *
 * Handles:
 * - Dynamic CLI registration with --approval-mode flag
 * - Session resumption via --resume flag
 */
export const geminiHandler: AgentConfigHandler = {
  processConfig(
    rawConfig: RawAgentConfig,
    _context: AgentConfigContext
  ): ProcessedAgentConfig {
    // Gemini doesn't have model env var mapping (uses default)
    const existingEnv = rawConfig.env || rawConfig.agentConfig?.env;

    // Check for dangerouslySkipPermissions toggle
    const dangerouslySkipPermissions =
      rawConfig.dangerouslySkipPermissions === true ||
      rawConfig.agentConfig?.dangerouslySkipPermissions === true;

    // Session mode
    const sessionMode = rawConfig.mode || rawConfig.agentConfig?.mode;

    return {
      env: existingEnv,
      acpPermissionMode: dangerouslySkipPermissions
        ? "auto-approve"
        : "interactive",
      skipPermissions: dangerouslySkipPermissions,
      sessionMode,
      mcpServers: rawConfig.mcpServers,
    };
  },

  applySetup(
    _rawConfig: RawAgentConfig,
    processedConfig: ProcessedAgentConfig,
    context: AgentConfigContext
  ): void {
    // Gemini CLI needs dynamic registration with appropriate flags
    const approvalMode = processedConfig.skipPermissions ? "yolo" : "default";
    const args = [
      "@google/gemini-cli",
      "--experimental-acp",
      "--approval-mode",
      approvalMode,
    ];

    // Add resume flag for follow-up executions
    if (context.isResume) {
      args.push("--resume", "latest");
      console.log(`[GeminiHandler] Will resume latest session`);
    }

    AgentFactory.register("gemini", {
      command: "npx",
      args,
      env: {},
    });

    console.log(
      `[GeminiHandler] Registered with approval mode: ${approvalMode}`
    );
  },
};

// =============================================================================
// Codex Handler
// =============================================================================

/**
 * Configuration handler for OpenAI Codex agent
 *
 * Handles:
 * - Dynamic CLI registration of codex-acp with `-c` config overrides for
 *   approval_policy, sandbox_mode and model, then the user's configOverrides
 * - fullAuto mode (convenience alias for workspace-write + on-request)
 */
export const codexHandler: AgentConfigHandler = {
  checkConfig(rawConfig: RawAgentConfig): void {
    const configOverrides: unknown = (rawConfig.agentConfig || rawConfig)
      .configOverrides;
    if (configOverrides === undefined) return;
    const entries =
      typeof configOverrides === "object" &&
      configOverrides !== null &&
      !Array.isArray(configOverrides)
        ? Object.entries(configOverrides)
        : null;
    const invalid =
      entries === null
        ? ["configOverrides must be an object of key to string value"]
        : entries
            .filter(
              ([key, value]) =>
                key === "" || key.includes("=") || typeof value !== "string"
            )
            .map(
              ([key]) =>
                `configOverrides[${JSON.stringify(key)}] must be a string, under a non-empty key without "="`
            );
    if (invalid.length > 0) {
      throw new AgentConfigValidationError("codex", invalid);
    }
  },

  processConfig(
    rawConfig: RawAgentConfig,
    _context: AgentConfigContext
  ): ProcessedAgentConfig {
    // Check for dangerouslySkipPermissions toggle
    const dangerouslySkipPermissions =
      rawConfig.dangerouslySkipPermissions === true ||
      rawConfig.agentConfig?.dangerouslySkipPermissions === true;

    // Session mode
    const sessionMode = rawConfig.mode || rawConfig.agentConfig?.mode;

    return {
      env: rawConfig.env || rawConfig.agentConfig?.env,
      acpPermissionMode: dangerouslySkipPermissions
        ? "auto-approve"
        : "interactive",
      skipPermissions: dangerouslySkipPermissions,
      sessionMode,
      mcpServers: rawConfig.mcpServers,
    };
  },

  applySetup(
    rawConfig: RawAgentConfig,
    processedConfig: ProcessedAgentConfig,
    _context: AgentConfigContext
  ): void {
    const codexConfig: CodexOptions = rawConfig.agentConfig || rawConfig;
    const model = rawConfig.model || rawConfig.agentConfig?.model;

    // Determine approval policy
    // Priority: dangerouslySkipPermissions > fullAuto > askForApproval > default
    let approvalPolicy: string;
    let sandbox: string | undefined;

    if (processedConfig.skipPermissions) {
      // dangerouslySkipPermissions takes highest priority
      approvalPolicy = "never";
      sandbox = "danger-full-access";
      console.log(`[CodexHandler] Using dangerouslySkipPermissions mode`);
    } else if (codexConfig.fullAuto) {
      // fullAuto is equivalent to: -a on-request --sandbox workspace-write
      approvalPolicy = "on-request";
      sandbox = "workspace-write";
      console.log(`[CodexHandler] Using fullAuto mode`);
    } else {
      // Use explicit settings or defaults
      approvalPolicy = codexConfig.askForApproval || "untrusted";
      sandbox = codexConfig.sandbox;
      console.log(
        `[CodexHandler] Using custom settings: approval=${approvalPolicy}, sandbox=${sandbox || "default"}`
      );
    }

    // Codex config keys, then the user's overrides, which win on conflict
    const settings: Record<string, string> = {
      approval_policy: approvalPolicy,
      ...(sandbox && { sandbox_mode: sandbox }),
      ...(model && { model }),
      ...codexConfig.configOverrides,
    };
    const args = [
      "@zed-industries/codex-acp",
      ...Object.entries(settings).flatMap(([key, value]) => [
        "-c",
        `${key}=${value}`,
      ]),
    ];

    AgentFactory.register("codex", {
      command: "npx",
      args,
      env: {},
    });

    console.log(`[CodexHandler] Registered with args:`, args.slice(1));
  },
};

// =============================================================================
// Copilot Handler
// =============================================================================

/**
 * Configuration handler for GitHub Copilot CLI agent
 *
 * Handles:
 * - Dynamic CLI registration with --continue flag for session resume
 * - Model selection via --model flag
 * - Permission handling
 *
 * Note: Copilot CLI supports session persistence via:
 * - `--continue`: Resume the most recently closed local session
 * - `--resume`: Cycle through and resume local/remote sessions
 */
export const copilotHandler: AgentConfigHandler = {
  processConfig(
    rawConfig: RawAgentConfig,
    _context: AgentConfigContext
  ): ProcessedAgentConfig {
    const existingEnv = rawConfig.env || rawConfig.agentConfig?.env;

    // Check for dangerouslySkipPermissions toggle
    const dangerouslySkipPermissions =
      rawConfig.dangerouslySkipPermissions === true ||
      rawConfig.agentConfig?.dangerouslySkipPermissions === true;

    // Session mode
    const sessionMode = rawConfig.mode || rawConfig.agentConfig?.mode;

    return {
      env: existingEnv,
      acpPermissionMode: dangerouslySkipPermissions
        ? "auto-approve"
        : "interactive",
      skipPermissions: dangerouslySkipPermissions,
      sessionMode,
      mcpServers: rawConfig.mcpServers,
    };
  },

  applySetup(
    rawConfig: RawAgentConfig,
    _processedConfig: ProcessedAgentConfig,
    context: AgentConfigContext
  ): void {
    // Build CLI arguments for Copilot
    const args = ["@github/copilot", "--acp"];

    // Add model flag if specified
    const model = rawConfig.model || rawConfig.agentConfig?.model;
    if (model) {
      args.push("--model", model);
    }

    // TODO: Note that Copilot doesn't actually support both --acp and --resume simultaneously and this is a no-op.
    // Add session resume flag for follow-up executions
    // Prefer --resume <sessionId> if we have a specific session ID,
    // fall back to --continue (most recent) otherwise
    if (context.isResume) {
      if (context.sessionId) {
        args.push("--resume", context.sessionId);
        console.log(
          `[CopilotHandler] Will resume session: ${context.sessionId}`
        );
      } else {
        args.push("--continue");
        console.log(`[CopilotHandler] Will continue from most recent session`);
      }
    }

    AgentFactory.register("copilot", {
      command: "npx",
      args,
      env: {},
    });

    console.log(`[CopilotHandler] Registered with args:`, args.slice(1));
  },
};

// =============================================================================
// Default Handler
// =============================================================================

/**
 * Default configuration handler for agents without specific handling
 */
export const defaultHandler: AgentConfigHandler = {
  processConfig(
    rawConfig: RawAgentConfig,
    _context: AgentConfigContext
  ): ProcessedAgentConfig {
    const existingEnv = rawConfig.env || rawConfig.agentConfig?.env;

    const dangerouslySkipPermissions =
      rawConfig.dangerouslySkipPermissions === true ||
      rawConfig.agentConfig?.dangerouslySkipPermissions === true;

    const sessionMode = rawConfig.mode || rawConfig.agentConfig?.mode;

    return {
      env: existingEnv,
      acpPermissionMode: dangerouslySkipPermissions
        ? "auto-approve"
        : "interactive",
      skipPermissions: dangerouslySkipPermissions,
      sessionMode,
      mcpServers: rawConfig.mcpServers,
    };
  },
};

// =============================================================================
// Handler Registry
// =============================================================================

const handlers: Record<string, AgentConfigHandler> = {
  "claude-code": claudeCodeHandler,
  gemini: geminiHandler,
  codex: codexHandler,
  copilot: copilotHandler,
};

/**
 * Get the configuration handler for an agent type
 *
 * @param agentType - The agent type (e.g., "claude-code", "gemini")
 * @returns The handler for the agent, or defaultHandler if not found
 */
export function getAgentConfigHandler(agentType: string): AgentConfigHandler {
  return handlers[agentType] || defaultHandler;
}

/**
 * Reject agent configuration the agent cannot launch with, before an
 * execution record or worktree is created for it
 *
 * @throws AgentConfigValidationError
 */
export function checkAgentConfig(
  agentType: string,
  rawConfig: RawAgentConfig
): void {
  getAgentConfigHandler(agentType).checkConfig?.(rawConfig);
}

/**
 * Process agent configuration using the appropriate handler
 *
 * This is a convenience function that:
 * 1. Gets the appropriate handler for the agent type
 * 2. Processes the raw config
 * 3. Applies any agent-specific setup
 *
 * @param agentType - The agent type
 * @param rawConfig - Raw configuration from frontend/API
 * @param context - Execution context (isResume, workDir)
 * @returns Processed configuration ready for executor
 */
export function processAgentConfig(
  agentType: string,
  rawConfig: RawAgentConfig,
  context: AgentConfigContext
): ProcessedAgentConfig {
  const handler = getAgentConfigHandler(agentType);
  const processedConfig = handler.processConfig(rawConfig, context);

  // Apply any agent-specific setup (e.g., dynamic registration)
  if (handler.applySetup) {
    handler.applySetup(rawConfig, processedConfig, context);
  }

  console.log(`[AgentConfigHandler] Processed config for ${agentType}:`, {
    skipPermissions: processedConfig.skipPermissions,
    acpPermissionMode: processedConfig.acpPermissionMode,
    agentPermissionMode: processedConfig.agentPermissionMode,
    sessionMode: processedConfig.sessionMode,
    hasEnv: !!processedConfig.env,
  });

  return processedConfig;
}

/**
 * Get the session permission mode to set after session creation
 *
 * @param agentType - The agent type
 * @param processedConfig - Processed configuration
 * @returns Mode string to pass to session.setMode(), or undefined to skip
 */
export function getSessionPermissionMode(
  agentType: string,
  processedConfig: ProcessedAgentConfig
): string | undefined {
  const handler = getAgentConfigHandler(agentType);
  return handler.getSessionPermissionMode?.(processedConfig);
}

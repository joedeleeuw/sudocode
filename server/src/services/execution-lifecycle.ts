/**
 * Execution Lifecycle Service
 *
 * Centralized service for managing execution lifecycle with worktree integration.
 * Coordinates between WorktreeManager and execution database services.
 *
 * @module services/execution-lifecycle
 */

import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import type { AgentType, Execution, ExternalLink } from "@sudocode-ai/types";
import { execSync } from "child_process";
import {
  WorktreeManager,
  type IWorktreeManager,
} from "../execution/worktree/manager.js";
import {
  canonicalWorktreePath,
  getWorktreeConfig,
  isManagedWorktree,
  renderBranchTemplate,
} from "../execution/worktree/config.js";
import { createExecution, getExecution } from "./executions.js";
import {
  WorktreeError,
  WorktreeErrorCode,
  type WorktreeCreateParams,
} from "../execution/worktree/types.js";
import { randomUUID } from "crypto";

/**
 * Parameters for creating a workflow-level worktree
 */
export interface CreateWorkflowWorktreeParams {
  /** Workflow ID (used for path generation) */
  workflowId: string;
  /** Workflow title (used for branch name generation) */
  workflowTitle: string;
  /** Base branch to create the workflow branch from */
  baseBranch: string;
  /** Path to the git repository */
  repoPath: string;
  /** If set, reuse existing worktree at this path instead of creating new */
  reuseWorktreePath?: string;
}

/**
 * Result of creating a workflow worktree
 */
export interface CreateWorkflowWorktreeResult {
  /** Path to the worktree directory */
  worktreePath: string;
  /** Name of the branch in the worktree */
  branchName: string;
}

/**
 * Parameters for creating an execution with worktree
 */
export interface CreateExecutionWithWorktreeParams {
  issueId: string;
  issueTitle: string;
  /** ID of the issue's first external link, for the `{externalId}` branch token */
  issueExternalId?: ExternalLink["external_id"];
  agentType: AgentType;
  targetBranch: string;
  repoPath: string;
  mode?: string;
  prompt?: string;
  config?: string; // JSON string of execution configuration
  createTargetBranch?: boolean; // If true, create targetBranch from current HEAD
  parentExecutionId?: string; // Link to parent execution (for follow-up/resume chains)
}

/**
 * Result of creating an execution with worktree
 */
export interface CreateExecutionWithWorktreeResult {
  execution: Execution;
  worktreePath: string;
  branchName: string;
}

/**
 * ExecutionLifecycleService
 *
 * Manages the full lifecycle of executions with worktree support:
 * - Creating executions with isolated worktrees
 * - Cleaning up executions and associated worktrees
 * - Handling orphaned worktrees
 */
export class ExecutionLifecycleService {
  private worktreeManager: IWorktreeManager;
  private db: Database.Database;
  private repoPath: string;

  /**
   * Create a new ExecutionLifecycleService
   *
   * @param db - Database instance
   * @param repoPath - Path to the git repository
   * @param worktreeManager - Optional worktree manager (defaults to new instance)
   */
  constructor(
    db: Database.Database,
    repoPath: string,
    worktreeManager?: IWorktreeManager
  ) {
    this.db = db;
    this.repoPath = repoPath;

    // Load config and create worktree manager if not provided
    if (worktreeManager) {
      this.worktreeManager = worktreeManager;
    } else {
      const config = getWorktreeConfig(repoPath);
      this.worktreeManager = new WorktreeManager(config);
    }
  }

  /**
   * Create an execution with an isolated worktree
   *
   * Creates a worktree first, then creates the execution record.
   * If worktree creation fails, no execution is created.
   * If execution creation fails, the worktree is cleaned up.
   *
   * @param params - Execution creation parameters
   * @returns Execution with worktree information
   * @throws Error if creation fails
   */
  async createExecutionWithWorktree(
    params: CreateExecutionWithWorktreeParams
  ): Promise<CreateExecutionWithWorktreeResult> {
    const {
      issueId,
      issueTitle,
      agentType,
      targetBranch,
      repoPath,
      createTargetBranch,
    } = params;

    // Validation 1: Check for existing active execution for this issue
    const existingExecution = this.db
      .prepare(
        `SELECT id FROM executions
         WHERE issue_id = ?
         AND status = 'running'
         AND worktree_path IS NOT NULL`
      )
      .get(issueId) as { id: string } | undefined;

    if (existingExecution) {
      throw new Error(
        `Active execution already exists for issue ${issueId}: ${existingExecution.id}`
      );
    }

    // Validation 2: Validate git repository
    const isValidRepo = await this.worktreeManager.isValidRepo(repoPath);
    if (!isValidRepo) {
      throw new Error(`Not a git repository: ${repoPath}`);
    }

    // Validation 3: Validate target branch exists (or create it if requested)
    const branches = await this.worktreeManager.listBranches(repoPath);
    if (!branches.includes(targetBranch)) {
      if (createTargetBranch) {
        // Create the branch from current HEAD
        const currentBranch =
          await this.worktreeManager.getCurrentBranch(repoPath);
        await this.worktreeManager.createBranch(
          repoPath,
          targetBranch,
          currentBranch
        );
        console.log(
          `[ExecutionLifecycle] Created new branch '${targetBranch}' from '${currentBranch}'`
        );
      } else {
        throw new Error(`Target branch does not exist: ${targetBranch}`);
      }
    }

    const config = this.worktreeManager.getConfig();

    // Generate execution ID
    const executionId = randomUUID();

    // Branch name from worktree.branchTemplate
    // (default: {prefix}/{executionId}/{title}), or the target branch itself
    // when not auto-creating branches
    const renderedName = config.autoCreateBranches
      ? renderBranchTemplate(config.branchTemplate, {
          prefix: config.branchPrefix,
          issueId,
          externalId: sanitizeForBranchName(params.issueExternalId ?? ""),
          title: sanitizeForBranchName(issueTitle),
          executionId: executionId.substring(0, 8),
        })
      : targetBranch;

    // Worktree path: {repoPath}/{worktreeStoragePath}/{execution-id} with the
    // "git" provider; wt's worktree-path template decides with "worktrunk"
    const requestedPath =
      config.provider === "worktrunk"
        ? undefined
        : path.join(repoPath, config.worktreeStoragePath, executionId);

    let worktreePath: string | undefined;
    let branchName = renderedName;

    try {
      // Step 1: Capture current commit before creating worktree
      let beforeCommit: string | undefined;
      try {
        beforeCommit = execSync("git rev-parse HEAD", {
          cwd: repoPath,
          encoding: "utf-8",
        }).trim();
        console.log(
          `[ExecutionLifecycle] Captured before_commit: ${beforeCommit}`
        );
      } catch (error) {
        console.warn(
          "[ExecutionLifecycle] Failed to capture before_commit:",
          error instanceof Error ? error.message : String(error)
        );
        // Continue - this is supplementary data
      }

      // Step 2: Create worktree
      if (config.autoCreateBranches) {
        ({ worktreePath, branchName } = await this.createWorktreeOnFreeBranch(
          renderedName,
          { repoPath, worktreePath: requestedPath, baseBranch: targetBranch }
        ));
      } else {
        worktreePath = await this.worktreeManager.createWorktree({
          repoPath,
          branchName,
          worktreePath: requestedPath,
          baseBranch: targetBranch,
          createBranch: false,
        });
      }

      // Step 3: Create execution record in database
      const execution = createExecution(this.db, {
        id: executionId,
        issue_id: issueId,
        agent_type: agentType,
        mode: params.mode,
        prompt: params.prompt,
        config: params.config,
        before_commit: beforeCommit,
        target_branch: targetBranch,
        branch_name: branchName,
        worktree_path: worktreePath,
        parent_execution_id: params.parentExecutionId,
      });

      return {
        execution,
        worktreePath,
        branchName,
      };
    } catch (error) {
      // If worktree was created but execution creation failed, cleanup worktree
      if (worktreePath !== undefined) {
        try {
          await this.worktreeManager.cleanupWorktree(worktreePath, repoPath);
        } catch (cleanupError) {
          // Log cleanup error but throw original error
          console.error(
            `Failed to cleanup worktree after execution creation failure:`,
            cleanupError
          );
        }
      }

      // Re-throw the original error
      throw error;
    }
  }

  /**
   * Create a worktree on a new branch named `renderedName`, or on its first
   * free `-2`, `-3`, … suffix. Names this process is still creating in
   * the same checkout are reserved, so concurrent executions rendering the
   * same name get distinct branches; a name that already exists is skipped.
   * A branch another process creates after that check is not retried: the
   * creation fails.
   */
  private async createWorktreeOnFreeBranch(
    renderedName: string,
    params: Omit<WorktreeCreateParams, "branchName" | "createBranch">
  ): Promise<{ worktreePath: string; branchName: string }> {
    const reserved = reservedBranchNames(params.repoPath);
    for (let suffix = 1; ; suffix++) {
      const branchName =
        suffix === 1 ? renderedName : `${renderedName}-${suffix}`;
      if (reserved.has(branchName)) continue;

      reserved.add(branchName);
      try {
        const worktreePath = await this.worktreeManager.createWorktree({
          ...params,
          branchName,
          createBranch: true,
        });
        return { worktreePath, branchName };
      } catch (error) {
        if (
          error instanceof WorktreeError &&
          error.code === WorktreeErrorCode.BRANCH_EXISTS
        ) {
          continue;
        }
        throw error;
      } finally {
        reserved.delete(branchName);
      }
    }
  }

  /**
   * Check if an execution should be cleaned up based on its config
   *
   * @param executionId - ID of execution to check
   * @returns true if should cleanup, false otherwise
   */
  shouldCleanupExecution(executionId: string): boolean {
    const execution = getExecution(this.db, executionId);

    if (!execution) {
      return false;
    }

    // Check if cleanupMode is set to 'manual'
    if (execution.config) {
      try {
        const config = JSON.parse(execution.config);
        if (config.cleanupMode === "manual" || config.cleanupMode === "never") {
          return false;
        }
      } catch (error) {
        console.error(
          `Failed to parse execution config for ${executionId}:`,
          error
        );
        // Default to cleanup on parse error
      }
    }

    return true;
  }

  /**
   * Clean up an execution and its associated worktree
   *
   * Removes the worktree from filesystem and git metadata.
   * Branch deletion is controlled by autoDeleteBranches config.
   * Respects the cleanupMode configuration from execution config.
   *
   * IMPORTANT: The worktree_path is NEVER cleared from the database.
   * This allows follow-up executions to find and reuse the same worktree path.
   * The filesystem worktree is deleted, but the path remains in the DB as a historical record.
   *
   * @param executionId - ID of execution to cleanup
   * @throws Error if cleanup fails
   */
  async cleanupExecution(executionId: string): Promise<void> {
    // Check if we should cleanup based on config
    if (!this.shouldCleanupExecution(executionId)) {
      return;
    }

    // Get execution from database
    const execution = getExecution(this.db, executionId);

    if (!execution) {
      // Execution doesn't exist, nothing to cleanup
      return;
    }

    // If execution has a worktree path, clean up the filesystem worktree
    // but KEEP the worktree_path in the database for follow-up executions
    if (execution.worktree_path) {
      try {
        await this.worktreeManager.cleanupWorktree(
          execution.worktree_path,
          this.repoPath
        );
        console.log(
          `Successfully cleaned up worktree for execution ${executionId}`
        );
        // NOTE: We do NOT set worktree_path to null in the database
        // Follow-up executions need this path to recreate the worktree
      } catch (error: any) {
        // Check if error is due to worktree already being deleted
        if (
          error.code === "ENOENT" ||
          error.message?.includes("does not exist")
        ) {
          console.log(
            `Worktree already deleted for execution ${executionId}, skipping cleanup`
          );
        } else {
          // Log other errors but don't fail - cleanup is best-effort
          console.error(
            `Failed to cleanup worktree for execution ${executionId}:`,
            error
          );
        }
      }
    }
  }

  /**
   * Clean up orphaned worktrees
   *
   * Finds worktrees that are registered in git but don't have
   * corresponding execution records (i.e., the execution was deleted).
   * Worktrees for existing executions (regardless of status) are preserved.
   */
  async cleanupOrphanedWorktrees(): Promise<void> {
    const repoPath = this.repoPath;
    const config = this.worktreeManager.getConfig();

    try {
      // Check if this is a valid git repository first
      const isValidRepo = await this.worktreeManager.isValidRepo(repoPath);
      if (!isValidRepo) {
        return;
      }

      // List all worktrees from git
      const worktrees = await this.worktreeManager.listWorktrees(repoPath);

      const managedWorktrees = worktrees.filter((w) =>
        isManagedWorktree(config, w)
      );

      // Paths recorded by executions and workflows, compared canonically
      const recordedPaths = new Set(
        (
          this.db
            .prepare(
              `SELECT worktree_path FROM executions WHERE worktree_path IS NOT NULL
               UNION
               SELECT worktree_path FROM workflows WHERE worktree_path IS NOT NULL`
            )
            .all() as { worktree_path: string }[]
        ).map((row) => canonicalWorktreePath(row.worktree_path))
      );

      // For each managed worktree, check if an execution or workflow records it
      for (const worktree of managedWorktrees) {
        const worktreePath = worktree.path;

        if (!recordedPaths.has(canonicalWorktreePath(worktreePath))) {
          // Orphaned worktree - no execution or workflow records it, cleanup
          console.log(
            `Cleaning up orphaned worktree: ${worktreePath} (no execution or workflow found)`
          );
          try {
            await this.worktreeManager.cleanupWorktree(worktreePath, repoPath);
          } catch (error) {
            console.error(
              `Failed to cleanup orphaned worktree ${worktreePath}:`,
              error
            );
          }
        }
        // Worktrees recorded by executions (any status) or workflows are preserved
      }
    } catch (error) {
      console.error(
        `Failed to cleanup orphaned worktrees in ${repoPath}:`,
        error
      );
    }
  }

  /**
   * Create a workflow-level worktree
   *
   * Creates a worktree that will be shared across all executions in a workflow.
   * The orchestrator and all step executions run in this same worktree.
   *
   * @param params - Workflow worktree creation parameters
   * @returns Worktree path and branch name
   * @throws Error if creation fails
   */
  async createWorkflowWorktree(
    params: CreateWorkflowWorktreeParams
  ): Promise<CreateWorkflowWorktreeResult> {
    const { workflowId, workflowTitle, baseBranch, repoPath, reuseWorktreePath } =
      params;

    // If reuseWorktreePath is specified, validate and return it
    if (reuseWorktreePath) {
      // Validate path exists
      if (!fs.existsSync(reuseWorktreePath)) {
        throw new Error(
          `Cannot reuse worktree: path does not exist: ${reuseWorktreePath}`
        );
      }

      // Validate it's a git worktree
      const gitPath = path.join(reuseWorktreePath, ".git");
      if (!fs.existsSync(gitPath)) {
        throw new Error(
          `Cannot reuse worktree: not a valid git worktree: ${reuseWorktreePath}`
        );
      }

      // Get branch name from the worktree
      let branchName: string;
      try {
        branchName = execSync("git rev-parse --abbrev-ref HEAD", {
          cwd: reuseWorktreePath,
          encoding: "utf-8",
        }).trim();
      } catch {
        throw new Error(
          `Cannot reuse worktree: failed to get branch name from: ${reuseWorktreePath}`
        );
      }

      console.log(
        `[ExecutionLifecycle] Reusing existing worktree: ${reuseWorktreePath} (branch: ${branchName})`
      );

      return {
        worktreePath: reuseWorktreePath,
        branchName,
      };
    }

    // Validate git repository
    const isValidRepo = await this.worktreeManager.isValidRepo(repoPath);
    if (!isValidRepo) {
      throw new Error(`Not a git repository: ${repoPath}`);
    }

    // Validate base branch exists
    const branches = await this.worktreeManager.listBranches(repoPath);
    if (!branches.includes(baseBranch)) {
      throw new Error(`Base branch does not exist: ${baseBranch}`);
    }

    const config = this.worktreeManager.getConfig();

    // Generate branch name: {branchPrefix}/workflow/{workflowId-8-chars}/{sanitized-title}
    const sanitizedTitle = sanitizeForBranchName(workflowTitle);
    const workflowIdShort = workflowId.replace("wf-", "").substring(0, 8);
    const renderedName = `${config.branchPrefix}/workflow/${workflowIdShort}/${sanitizedTitle}`;

    // Worktree path: {repoPath}/{worktreeStoragePath}/workflow-{workflowId} with
    // the "git" provider; wt's worktree-path template decides with "worktrunk"
    const requestedPath =
      config.provider === "worktrunk"
        ? undefined
        : path.join(repoPath, config.worktreeStoragePath, `workflow-${workflowId}`);

    // Create the worktree, on a new branch with a -N suffix if the name is taken
    try {
      const { worktreePath, branchName } =
        await this.createWorktreeOnFreeBranch(renderedName, {
          repoPath,
          worktreePath: requestedPath,
          baseBranch,
        });

      console.log(
        `[ExecutionLifecycle] Created workflow worktree: ${worktreePath} (branch: ${branchName})`
      );

      return {
        worktreePath,
        branchName,
      };
    } catch (error) {
      console.error(
        `[ExecutionLifecycle] Failed to create workflow worktree:`,
        error
      );
      throw error;
    }
  }
}

/**
 * Branch names being created in each repository by this process
 */
const reservedBranchNamesByRepo = new Map<string, Set<string>>();

function reservedBranchNames(repoPath: string): Set<string> {
  const key = canonicalWorktreePath(repoPath);
  const reserved = reservedBranchNamesByRepo.get(key) ?? new Set<string>();
  reservedBranchNamesByRepo.set(key, reserved);
  return reserved;
}

/**
 * Sanitize a string to be safe for use in git branch names
 *
 * - Converts to lowercase
 * - Replaces spaces and slashes with hyphens
 * - Removes special characters
 * - Limits length to 50 characters
 *
 * @param str - String to sanitize
 * @returns Sanitized string safe for branch names
 */
export function sanitizeForBranchName(str: string): string {
  return (
    str
      .toLowerCase()
      // Replace spaces and slashes with hyphens
      .replace(/[\s/]+/g, "-")
      // Remove special characters (keep alphanumeric, hyphens, underscores)
      .replace(/[^a-z0-9\-_]/g, "")
      // Remove consecutive hyphens
      .replace(/-+/g, "-")
      // Remove leading/trailing hyphens
      .replace(/^-+|-+$/g, "")
      // Limit length
      .substring(0, 50)
  );
}

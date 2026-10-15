import { Router, Request, Response } from "express";
import {
  getRepositoryInfo,
  getRepositoryBranches,
} from "../services/repo-info.js";
import { GitSyncCli } from "../execution/worktree/git-sync-cli.js";
import { ConflictDetector } from "../execution/worktree/conflict-detector.js";
import * as fs from "fs";
import {
  canonicalWorktreePath,
  isManagedWorktree,
} from "../execution/worktree/config.js";

export function createRepoInfoRouter(): Router {
  const router = Router();

  // Repository info endpoint - returns git repository information for current project
  router.get("/", async (req: Request, res: Response): Promise<void> => {
    try {
      const repoInfo = await getRepositoryInfo(req.project!.path);
      res.status(200).json({
        success: true,
        data: repoInfo,
      });
    } catch (error) {
      const err = error as Error;
      if (err.message === "Not a git repository") {
        res.status(404).json({
          success: false,
          data: null,
          message: err.message,
        });
      } else {
        console.error("Failed to get repository info:", error);
        res.status(500).json({
          success: false,
          data: null,
          message: "Failed to get repository info",
        });
      }
    }
  });

  // Repository branches endpoint - returns list of all local branches
  router.get(
    "/branches",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const branchInfo = await getRepositoryBranches(req.project!.path);
        res.status(200).json({
          success: true,
          data: branchInfo,
        });
      } catch (error) {
        const err = error as Error;
        if (err.message === "Not a git repository") {
          res.status(404).json({
            success: false,
            data: null,
            message: err.message,
          });
        } else {
          console.error("Failed to get repository branches:", error);
          res.status(500).json({
            success: false,
            data: null,
            message: "Failed to get repository branches",
          });
        }
      }
    }
  );

  // Worktrees endpoint - returns the git worktrees sudocode manages (see
  // isManagedWorktree: under worktreeStoragePath, or on our branch prefix with
  // the "worktrunk" provider), each with the execution that records it
  router.get("/worktrees", async (req: Request, res: Response): Promise<void> => {
    try {
      const db = req.project!.db;
      const repoPath = req.project!.path;
      const worktreeManager = req.project!.worktreeManager;
      const config = worktreeManager.getConfig();

      const managed = (await worktreeManager.listWorktrees(repoPath)).filter(
        (worktree) => isManagedWorktree(config, worktree)
      );

      // First execution recording each worktree, keyed by canonical path so
      // a recorded /var/... path matches git's /private/var/... listing
      const executionsByPath = new Map<string, unknown>();
      for (const execution of db
        .prepare(
          `SELECT * FROM executions WHERE worktree_path IS NOT NULL ORDER BY rowid`
        )
        .all() as { worktree_path: string }[]) {
        const key = canonicalWorktreePath(execution.worktree_path);
        if (!executionsByPath.has(key)) executionsByPath.set(key, execution);
      }

      const worktrees = managed.map((worktree) => {
        const execution = executionsByPath.get(
          canonicalWorktreePath(worktree.path)
        );

        // Worktree exists but no execution record - return minimal info
        return (
          execution ?? {
            id: null,
            worktree_path: worktree.path,
            branch_name: worktree.branch,
            status: "orphaned",
            created_at: null,
            updated_at: null,
          }
        );
      });

      res.json({
        success: true,
        data: worktrees,
      });
    } catch (error) {
      console.error("Error listing worktrees:", error);
      res.status(500).json({
        success: false,
        data: null,
        error_data: error instanceof Error ? error.message : String(error),
        message: "Failed to list worktrees",
      });
    }
  });

  // Worktree sync preview endpoint - Preview sync for a worktree
  router.post(
    "/worktrees/preview",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const projectPath = req.project!.path;
        const { worktreePath, branchName, targetBranch } = req.body;

        // Validate inputs
        if (!worktreePath || !branchName || !targetBranch) {
          res.status(400).json({
            success: false,
            error: "Missing required parameters",
            message: "worktreePath, branchName, and targetBranch are required",
          });
          return;
        }

        // Check worktree exists
        if (!fs.existsSync(worktreePath)) {
          res.status(404).json({
            success: false,
            error: "Worktree not found",
            message: `Worktree does not exist at path: ${worktreePath}`,
          });
          return;
        }

        // Create git clients for main repo and worktree
        const mainGitSync = new GitSyncCli(projectPath);
        const worktreeGitSync = new GitSyncCli(worktreePath);
        const worktreeConflictDetector = new ConflictDetector(worktreePath);

        // Find merge base
        const mergeBase = mainGitSync.getMergeBase(branchName, targetBranch);

        // Get commit list
        const commits = mainGitSync.getCommitList(mergeBase, branchName);

        // Get diff summary
        const diff = mainGitSync.getDiff(mergeBase, branchName);

        // Detect conflicts
        const conflicts = worktreeConflictDetector.detectConflicts(
          branchName,
          targetBranch
        );

        // Check for uncommitted changes
        const uncommittedFiles = worktreeGitSync.getUncommittedFiles();
        const uncommittedStats = worktreeGitSync.getUncommittedStats();
        const uncommittedJSONL = uncommittedFiles.filter(
          (file) =>
            file.endsWith(".jsonl") &&
            (file.includes(".sudocode/") || file.startsWith(".sudocode/"))
        );

        // Generate warnings
        const warnings: string[] = [];

        if (conflicts.codeConflicts.length > 0) {
          warnings.push(
            `${conflicts.codeConflicts.length} code conflict(s) detected. Manual resolution required.`
          );
        }

        if (uncommittedJSONL.length > 0) {
          warnings.push(
            `${uncommittedJSONL.length} uncommitted JSONL file(s) will be included in sync.`
          );
        }

        // Determine if sync can proceed
        const canSync = conflicts.codeConflicts.length === 0;

        const preview = {
          canSync,
          conflicts,
          diff,
          commits,
          mergeBase,
          uncommittedJSONLChanges: uncommittedJSONL,
          uncommittedChanges: uncommittedStats,
          executionStatus: null, // Not execution-specific
          warnings,
        };

        res.json({
          success: true,
          data: preview,
        });
      } catch (error) {
        console.error("Failed to preview worktree sync:", error);
        res.status(500).json({
          success: false,
          error: "Failed to preview worktree sync",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  );

  return router;
}

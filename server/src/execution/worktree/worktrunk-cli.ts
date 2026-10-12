/**
 * Worktrunk (`wt`) CLI wrapper for the "worktrunk" worktree provider
 *
 * Worktrees are created with `wt switch --create … --no-cd` and removed with
 * `wt remove`, so they follow the user's worktrunk `worktree-path` template
 * (by default sibling `<repo>.<branch>` directories) and the repository's
 * worktrunk hooks run. `--yes` is never passed: unapproved project hooks make
 * wt fail with its approval message instead of running unreviewed commands.
 * Approve them once with `wt config approvals add`.
 *
 * @module execution/worktree/worktrunk-cli
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { WorktreeError, WorktreeErrorCode } from "./types.js";

const execFileAsync = promisify(execFile);

async function runWt(repoPath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("wt", ["-C", repoPath, ...args], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    if (failure.code === "ENOENT") {
      throw new WorktreeError(
        'worktree.provider is "worktrunk" but `wt` is not on PATH',
        WorktreeErrorCode.CONFIG_ERROR,
        failure
      );
    }
    throw new WorktreeError(
      `wt ${args.join(" ")} failed: ${(failure.stderr || failure.message).trim()}`,
      WorktreeErrorCode.GIT_ERROR,
      failure
    );
  }
}

/**
 * Create the worktree for a branch and return its path. Fails unless wt
 * created a new worktree: an existing one (e.g. the main checkout of the
 * target branch) belongs to someone else and must not be handed to an agent.
 *
 * @param base - Base ref when the branch must be created; null for an existing branch
 */
export async function wtSwitch(
  repoPath: string,
  branchName: string,
  base: string | null
): Promise<string> {
  const target =
    base === null ? [branchName] : ["--create", branchName, "--base", base];
  const stdout = await runWt(repoPath, [
    "switch",
    ...target,
    "--no-cd",
    "--format",
    "json",
  ]);

  const result: unknown = JSON.parse(stdout);
  if (
    typeof result !== "object" ||
    result === null ||
    !("path" in result) ||
    typeof result.path !== "string" ||
    !("action" in result)
  ) {
    throw new WorktreeError(
      `wt switch returned no worktree path: ${stdout.trim()}`,
      WorktreeErrorCode.GIT_ERROR
    );
  }
  if (result.action !== "created") {
    throw new WorktreeError(
      `wt switch ${branchName} did not create a new worktree (action ${JSON.stringify(result.action)}, path ${result.path}); ` +
        "sudocode needs a dedicated worktree for the branch",
      WorktreeErrorCode.PATH_EXISTS
    );
  }
  return result.path;
}

/**
 * Remove a worktree, discarding uncommitted changes. The branch is force-deleted
 * when deleteBranch is set and kept otherwise.
 */
export async function wtRemove(
  repoPath: string,
  worktreePath: string,
  deleteBranch: boolean
): Promise<void> {
  await runWt(repoPath, [
    "remove",
    worktreePath,
    "--foreground",
    "--force",
    deleteBranch ? "--force-delete" : "--no-delete-branch",
  ]);
}

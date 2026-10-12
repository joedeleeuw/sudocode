/**
 * Worktree Configuration
 *
 * Loads and validates the `worktree` section of the sudocode config
 * (`.sudocode/config.local.json`, merged with `.sudocode/config.json` by the
 * CLI's getConfig, which also migrates older single-file configs)
 *
 * @module execution/worktree/config
 */

import path from 'path';
import { getConfig } from '@sudocode-ai/cli/dist/config.js';
import type { WorktreeConfig, WorktreeInfo } from './types.js';

/**
 * Validation result
 */
interface ValidationResult {
  config: WorktreeConfig;
  warnings: string[];
}

/**
 * Default worktree configuration
 */
export const DEFAULT_WORKTREE_CONFIG: WorktreeConfig = {
  provider: 'git',
  worktreeStoragePath: '.sudocode/worktrees',
  autoCreateBranches: true,
  autoDeleteBranches: false,
  enableSparseCheckout: false,
  sparseCheckoutPatterns: undefined,
  branchPrefix: 'wt-sudocode',
  cleanupOrphanedWorktreesOnStartup: false,
};

/**
 * Validate and normalize worktree configuration
 *
 * @param rawConfig - The `worktree` section of the sudocode config
 * @returns Validated configuration with warnings
 */
export function validateWorktreeConfig(
  rawConfig: Partial<WorktreeConfig>
): ValidationResult {
  const warnings: string[] = [];
  const config: WorktreeConfig = { ...DEFAULT_WORKTREE_CONFIG };

  // Validate provider. An unknown value is an error, not a warning: falling
  // back to "git" would put worktrees somewhere the user did not ask for.
  if (rawConfig.provider !== undefined) {
    if (rawConfig.provider !== 'git' && rawConfig.provider !== 'worktrunk') {
      throw new Error(
        `Invalid worktree.provider ${JSON.stringify(rawConfig.provider)}: must be "git" or "worktrunk"`
      );
    }
    config.provider = rawConfig.provider;
  }

  // Validate worktreeStoragePath
  if (rawConfig.worktreeStoragePath !== undefined) {
    if (typeof rawConfig.worktreeStoragePath === 'string') {
      config.worktreeStoragePath = rawConfig.worktreeStoragePath;
    } else {
      warnings.push(
        `Invalid worktreeStoragePath: must be a string. Using default: ${DEFAULT_WORKTREE_CONFIG.worktreeStoragePath}`
      );
    }
  }

  // Validate autoCreateBranches
  if (rawConfig.autoCreateBranches !== undefined) {
    if (typeof rawConfig.autoCreateBranches === 'boolean') {
      config.autoCreateBranches = rawConfig.autoCreateBranches;
    } else {
      warnings.push(
        `Invalid autoCreateBranches: must be a boolean. Using default: ${DEFAULT_WORKTREE_CONFIG.autoCreateBranches}`
      );
    }
  }

  // Validate autoDeleteBranches
  if (rawConfig.autoDeleteBranches !== undefined) {
    if (typeof rawConfig.autoDeleteBranches === 'boolean') {
      config.autoDeleteBranches = rawConfig.autoDeleteBranches;
    } else {
      warnings.push(
        `Invalid autoDeleteBranches: must be a boolean. Using default: ${DEFAULT_WORKTREE_CONFIG.autoDeleteBranches}`
      );
    }
  }

  // Validate enableSparseCheckout
  if (rawConfig.enableSparseCheckout !== undefined) {
    if (typeof rawConfig.enableSparseCheckout === 'boolean') {
      config.enableSparseCheckout = rawConfig.enableSparseCheckout;
    } else {
      warnings.push(
        `Invalid enableSparseCheckout: must be a boolean. Using default: ${DEFAULT_WORKTREE_CONFIG.enableSparseCheckout}`
      );
    }
  }

  // Validate sparseCheckoutPatterns
  if (rawConfig.sparseCheckoutPatterns !== undefined) {
    if (
      Array.isArray(rawConfig.sparseCheckoutPatterns) &&
      rawConfig.sparseCheckoutPatterns.every((p: unknown) => typeof p === 'string')
    ) {
      config.sparseCheckoutPatterns = rawConfig.sparseCheckoutPatterns;
    } else {
      warnings.push(
        'Invalid sparseCheckoutPatterns: must be an array of strings. Ignoring value.'
      );
      config.sparseCheckoutPatterns = undefined;
    }
  }

  // Validate branchPrefix
  if (rawConfig.branchPrefix !== undefined) {
    if (typeof rawConfig.branchPrefix === 'string') {
      // Validate git branch name characters (basic validation)
      if (isValidGitBranchPrefix(rawConfig.branchPrefix)) {
        config.branchPrefix = rawConfig.branchPrefix;
      } else {
        warnings.push(
          `Invalid branchPrefix: contains invalid git branch name characters. Using default: ${DEFAULT_WORKTREE_CONFIG.branchPrefix}`
        );
      }
    } else {
      warnings.push(
        `Invalid branchPrefix: must be a string. Using default: ${DEFAULT_WORKTREE_CONFIG.branchPrefix}`
      );
    }
  }

  // Validate cleanupOrphanedWorktreesOnStartup
  if (rawConfig.cleanupOrphanedWorktreesOnStartup !== undefined) {
    if (typeof rawConfig.cleanupOrphanedWorktreesOnStartup === 'boolean') {
      config.cleanupOrphanedWorktreesOnStartup =
        rawConfig.cleanupOrphanedWorktreesOnStartup;
    } else {
      warnings.push(
        `Invalid cleanupOrphanedWorktreesOnStartup: must be a boolean. Using default: ${DEFAULT_WORKTREE_CONFIG.cleanupOrphanedWorktreesOnStartup}`
      );
    }
  }

  return { config, warnings };
}

/**
 * Validate git branch prefix characters
 * Basic validation - checks for common invalid characters
 *
 * @param prefix - Branch prefix to validate
 * @returns True if valid
 */
function isValidGitBranchPrefix(prefix: string): boolean {
  // Git branch names cannot contain: .., @{, \, ^, ~, :, ?, *, [, space, or control characters
  // Also cannot start with / or end with .lock
  const invalidPatterns = [
    /\.\./,
    /@\{/,
    /\\/,
    /\^/,
    /~/,
    /:/,
    /\?/,
    /\*/,
    /\[/,
    /\s/,
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x7f]/,
  ];

  if (prefix.startsWith('/') || prefix.endsWith('.lock')) {
    return false;
  }

  return !invalidPatterns.some((pattern) => pattern.test(prefix));
}

/**
 * Load worktree configuration for a project
 *
 * @param projectRoot - Path to project root (default: current working directory)
 * @returns Validated configuration with warnings
 */
export function loadWorktreeConfig(
  projectRoot: string = process.cwd()
): ValidationResult {
  const { worktree } = getConfig(path.join(projectRoot, '.sudocode'));
  return validateWorktreeConfig(worktree ?? {});
}

/**
 * Whether sudocode manages a git worktree: one under worktreeStoragePath with
 * the "git" provider; one on a branch with our prefix with "worktrunk", where
 * wt's worktree-path template chooses the location
 */
export function isManagedWorktree(
  config: WorktreeConfig,
  worktree: WorktreeInfo
): boolean {
  return config.provider === 'worktrunk'
    ? worktree.branch.startsWith(`${config.branchPrefix}/`)
    : worktree.path.includes(config.worktreeStoragePath);
}

/**
 * Singleton instance of worktree configuration
 */
let cachedConfig: WorktreeConfig | null = null;
let cachedProjectRoot: string | null = null;

/**
 * Get worktree configuration (singleton pattern)
 * Caches the configuration per project root
 *
 * @param projectRoot - Path to project root (default: current working directory)
 * @param forceReload - Force reload from disk
 * @returns Worktree configuration
 */
export function getWorktreeConfig(
  projectRoot: string = process.cwd(),
  forceReload = false
): WorktreeConfig {
  // Return cached config if same project root and not forcing reload
  if (!forceReload && cachedConfig && cachedProjectRoot === projectRoot) {
    return cachedConfig;
  }

  // Load and validate configuration
  const { config, warnings } = loadWorktreeConfig(projectRoot);

  // Log warnings
  if (warnings.length > 0) {
    console.warn('[Worktree Config] Configuration warnings:');
    warnings.forEach((warning) => console.warn(`  - ${warning}`));
  }

  // Cache the configuration
  cachedConfig = config;
  cachedProjectRoot = projectRoot;

  return config;
}

/**
 * Clear the cached configuration (useful for testing)
 */
export function clearWorktreeConfigCache(): void {
  cachedConfig = null;
  cachedProjectRoot = null;
}

/**
 * Worktree Configuration
 *
 * Loads and validates the `worktree` section of the sudocode config
 * (`.sudocode/config.local.json`, merged with `.sudocode/config.json` by the
 * CLI's getConfig, which also migrates older single-file configs)
 *
 * @module execution/worktree/config
 */

import fs from 'fs';
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
  branchTemplate: '{prefix}/{executionId}/{title}',
  cleanupOrphanedWorktreesOnStartup: false,
};

/**
 * Tokens a `branchTemplate` may use (see WorktreeConfig.branchTemplate)
 */
export const BRANCH_TEMPLATE_TOKENS = [
  'prefix',
  'issueId',
  'externalId',
  'title',
  'executionId',
] as const;

export type BranchTemplateToken = (typeof BRANCH_TEMPLATE_TOKENS)[number];

const TEMPLATE_TOKEN_PATTERN = /\{([^{}]*)\}/g;

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

  // Validate branchTemplate. Like provider, a bad template is an error: a
  // fallback would name branches differently from what the user configured.
  if (rawConfig.branchTemplate !== undefined) {
    config.branchTemplate = validateBranchTemplate(
      rawConfig.branchTemplate,
      config.provider
    );
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
 * Validate a branch name template: known tokens only, characters git allows
 * in branch names, and the `{prefix}/` start that worktrunk detection needs
 *
 * @throws Error naming the offending token or rule
 */
function validateBranchTemplate(
  template: unknown,
  provider: WorktreeConfig['provider']
): string {
  if (typeof template !== 'string' || template.length === 0) {
    throw new Error(
      `Invalid worktree.branchTemplate ${JSON.stringify(template)}: must be a non-empty string`
    );
  }

  for (const [token, name] of template.matchAll(TEMPLATE_TOKEN_PATTERN)) {
    if (!(BRANCH_TEMPLATE_TOKENS as readonly string[]).includes(name)) {
      throw new Error(
        `Invalid worktree.branchTemplate token ${token}: must be one of ${BRANCH_TEMPLATE_TOKENS.map((t) => `{${t}}`).join(', ')}`
      );
    }
  }

  const literal = template.replace(TEMPLATE_TOKEN_PATTERN, 'x');
  if (/[{}]/.test(literal) || !isValidGitBranchPrefix(literal)) {
    throw new Error(
      `Invalid worktree.branchTemplate ${JSON.stringify(template)}: contains an unclosed brace or characters git does not allow in branch names`
    );
  }

  if (provider === 'worktrunk' && !template.startsWith('{prefix}/')) {
    throw new Error(
      `Invalid worktree.branchTemplate ${JSON.stringify(template)}: must start with "{prefix}/" with the "worktrunk" provider, which recognizes the worktrees it manages by that prefix`
    );
  }

  return template;
}

/**
 * Render an execution branch name from a validated template. A token that
 * renders empty is dropped together with one adjacent separator, so an
 * optional token such as `{externalId}` leaves no dangling `-` or `/`.
 *
 * @param template - Validated `branchTemplate`
 * @param values - Branch-safe value for every token
 * @returns Branch name
 */
export function renderBranchTemplate(
  template: string,
  values: Record<BranchTemplateToken, string>
): string {
  const withoutEmpty = BRANCH_TEMPLATE_TOKENS.filter(
    (token) => values[token] === ''
  ).reduce(
    (text, token) =>
      text
        .replace(new RegExp(`\\{${token}\\}[-_./]`, 'g'), '')
        .replace(new RegExp(`[-_./]?\\{${token}\\}`, 'g'), ''),
    template
  );

  return withoutEmpty.replace(
    TEMPLATE_TOKEN_PATTERN,
    (_token, name: BranchTemplateToken) => values[name]
  );
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
 * A worktree path with symlinks resolved, so a path an execution recorded
 * (such as macOS /var/...) equals the one git lists for the same directory
 * (/private/var/...). A path that no longer exists is only made absolute.
 */
export function canonicalWorktreePath(worktreePath: string): string {
  return fs.existsSync(worktreePath)
    ? fs.realpathSync(worktreePath)
    : path.resolve(worktreePath);
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

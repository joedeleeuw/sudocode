# Repository Agent Instructions

This is joedeleeuw's fork of sudocode-ai/sudocode. Hosts install it from this fork's GitHub releases,
not npm: dotfiles `config/agents/clis.json` pins the meta-package tarball.

## Remotes and branches

- `fork` (github.com/joedeleeuw/sudocode over SSH) is the only push target. `upstream` is fetch-only
  and `sushi` is the GPU host's checkout.
- In a new clone, run `git config checkout.defaultRemote fork`. worktrunk names a project after that
  remote, else the first remote in `.git/config`. Its hook approval is stored under
  `github.com/joedeleeuw/sudocode`.
- Fork work branches from the newest `release/v*` branch. `main` tracks upstream.
- Create worktrees with `command wt -C <a fork worktree> switch --create …`. The primary checkout
  sits on upstream `main`, which has no `.config/wt.toml`, so wt run there skips the pre-start copy.

## Global hooks

The user's global git hooks require a `.pre-commit-config.yaml`. This fork opts out with an untracked
`.skip-global-hooks`, listed in `.git/info/exclude`. `.worktreeinclude` copies it into each new
worktree, together with `node_modules`.

## Releases

Run `node scripts/release-fork.ts 0.2.0-joe.N <notes.md>` from a clean checkout of the commit to
release. It:
- creates `release/v0.2.0-joe.N`;
- versions every package, with the meta-package at `1.2.0-joe.N`;
- rebuilds from empty `dist` directories;
- packs tarballs whose sibling dependencies point at the release asset URLs, and fails if a tarball is
  missing an entry point;
- tags, pushes to `fork` and creates the GitHub release.

Then bump the dotfiles pin (`source`, `version`, `pinReason`) and install with
`scripts/install-clis.sh --only sudocode`. `scripts/version.sh` and `scripts/publish.sh` are
upstream's npm flow; the fork does not publish to npm.

## Validation

Smoke the built CLI (`node cli/dist/cli.js … --json`) and the MCP server (`node mcp/dist/index.js`
over stdio) against real scratch git repositories. `npm test` runs the existing suites. The
release base has the same environmental failures: the global hooks in temporary repositories, and a
YAMLException in yaml-merge.

# Sudocode repository instructions

This upstream fork is an npm workspace: `types` owns contracts and SQLite schema, `cli` owns tracker persistence, `server` owns HTTP adapters, and `frontend` owns the UI.

Tracker JSONL files are durable state and SQLite is their cache. Database mutations acknowledged by CLI or HTTP callers go through `cli/src/tracker-mutation.ts`; fetch remote input before entering its synchronous callback. Anonymous feedback belongs to its target entity; issue-originated feedback belongs to its source issue. Import validates all references before recording synchronization hashes.

Run `npm run build`, `npm run typecheck --workspace=server`, and `npm test -- --pool=forks --maxWorkers=4`. Record real command exits and compare individual failures against the requested baseline. Never add mock tests or fixtures; prove persistence with the built CLI and server on a scratch tracker. Block core dumps and stop on worker crashes.

Keep `.sudocode/config.json` local edits uncommitted. This upstream fork uses an ignored `.skip-global-hooks` file, configured by its owner; never set hook-bypass environment variables or use `--no-verify`.

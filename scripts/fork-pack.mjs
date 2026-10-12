#!/usr/bin/env node
/**
 * Pack the fork's packages as GitHub release assets.
 *
 * Usage: node scripts/fork-pack.mjs <out-dir> [owner/repo]
 *
 * The fork is not published to npm. Each tarball is uploaded to the release
 * tagged v<package version> on the fork, and every dependency on a package
 * built here points at the sibling asset's URL, so installing the
 * meta-package tarball never resolves a registry build of a fork package.
 * Peer dependencies get the exact fork version: the registry never has it, so
 * a peer that is not satisfied by a fork tarball fails instead of drifting.
 *
 * The workspace manifests are rewritten only while `npm pack` runs and are
 * restored afterwards. Run `npm run build` first.
 */

import { execFileSync } from "child_process";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const [outArg, repo = "joedeleeuw/sudocode"] = process.argv.slice(2);
if (!outArg) {
  console.error("Usage: node scripts/fork-pack.mjs <out-dir> [owner/repo]");
  process.exit(1);
}
const outDir = resolve(outArg);

const PACKAGE_DIRS = [
  "types",
  "cli",
  "mcp",
  "server",
  "plugins/integration-github",
  "plugins/integration-beads",
  "plugins/integration-openspec",
  "plugins/integration-speckit",
  "sudocode",
];

const manifests = PACKAGE_DIRS.map((dir) => {
  const path = join(rootDir, dir, "package.json");
  const text = readFileSync(path, "utf-8");
  return { dir, path, text, pkg: JSON.parse(text) };
});

const version = manifests.find((m) => m.dir === "types").pkg.version;
const releaseBase = `https://github.com/${repo}/releases/download/v${version}`;
const tarballName = (pkg) =>
  `${pkg.name.replace(/^@/, "").replace("/", "-")}-${pkg.version}.tgz`;
const urls = new Map(
  manifests
    .filter((m) => m.pkg.name.startsWith("@sudocode-ai/"))
    .map((m) => [m.pkg.name, `${releaseBase}/${tarballName(m.pkg)}`])
);

function rewrite(pkg) {
  const out = structuredClone(pkg);
  for (const field of ["dependencies", "optionalDependencies"]) {
    for (const dep of Object.keys(out[field] ?? {})) {
      if (urls.has(dep)) out[field][dep] = urls.get(dep);
    }
  }
  for (const dep of Object.keys(out.peerDependencies ?? {})) {
    if (urls.has(dep)) out.peerDependencies[dep] = version;
  }
  return out;
}

mkdirSync(outDir, { recursive: true });
for (const m of manifests) {
  if (m.pkg.name.startsWith("@sudocode-ai/") && m.pkg.version !== version) {
    throw new Error(`${m.pkg.name} is ${m.pkg.version}, expected ${version}`);
  }
  writeFileSync(m.path, JSON.stringify(rewrite(m.pkg), null, 2) + "\n");
  try {
    const [packed] = JSON.parse(
      execFileSync("npm", ["pack", "--json", "--pack-destination", outDir], {
        cwd: join(rootDir, m.dir),
        encoding: "utf-8",
      })
    );
    if (packed.filename !== tarballName(m.pkg)) {
      throw new Error(`${m.pkg.name}: packed ${packed.filename}, expected ${tarballName(m.pkg)}`);
    }
    console.log(`${packed.filename} (${packed.entryCount} files)`);
  } finally {
    writeFileSync(m.path, m.text);
  }
}

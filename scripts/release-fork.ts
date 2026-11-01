import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const FORK_REPOSITORY = "joedeleeuw/sudocode";
const PACKAGE_DIRECTORIES = [
  "types",
  "cli",
  "mcp",
  "server",
  "plugins/integration-beads",
  "plugins/integration-github",
  "plugins/integration-openspec",
  "plugins/integration-speckit",
  "sudocode",
];
const VERSIONED_FILES = [
  ...PACKAGE_DIRECTORIES.map((directory) => `${directory}/package.json`),
  "frontend/package.json",
  "package.json",
  "package-lock.json",
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
];
const BUILT_DIRECTORIES = [...PACKAGE_DIRECTORIES.filter((directory) => directory !== "sudocode"), "frontend"];

type Manifest = {
  name: string;
  version: string;
  files?: string[];
  main?: string;
  bin?: Record<string, string>;
  exports?: unknown;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const [releaseVersion, notesPath] = process.argv.slice(2);
if (!releaseVersion || !notesPath) {
  throw new Error("usage: node scripts/release-fork.ts <0.2.0-joe.N> <release-notes.md>");
}
const versionParts = /^(\d+)\.(\d+\.\d+-joe\.\d+)$/.exec(releaseVersion);
if (!versionParts) {
  throw new Error(`release version ${releaseVersion} must look like 0.2.0-joe.N`);
}
const metaVersion = `${Number(versionParts[1]) + 1}.${versionParts[2]}`;
const releaseTag = `v${releaseVersion}`;
const releaseNotes = readFileSync(notesPath, "utf8");
const repositoryRoot = path.resolve(import.meta.dirname, "..");

const run = (command: string, args: string[], cwd = repositoryRoot) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const readManifest = (directory: string): Manifest =>
  JSON.parse(readFileSync(path.join(repositoryRoot, directory, "package.json"), "utf8"));

const forkRemote = run("git", ["remote"])
  .split("\n")
  .find((remote) => run("git", ["remote", "get-url", remote]).replace(/\.git$/, "").endsWith(FORK_REPOSITORY));
if (!forkRemote) {
  throw new Error(`no git remote points at ${FORK_REPOSITORY}`);
}
if (run("git", ["status", "--porcelain"]) !== "") {
  throw new Error("the working tree has uncommitted changes");
}
if (run("git", ["ls-remote", "--tags", forkRemote, `refs/tags/${releaseTag}`]) !== "") {
  throw new Error(`${releaseTag} already exists on ${forkRemote}`);
}

const currentVersion = readManifest("types").version;
const currentMetaVersion = readManifest("sudocode").version;
run("git", ["switch", "--create", `release/${releaseTag}`]);
for (const file of VERSIONED_FILES) {
  const filePath = path.join(repositoryRoot, file);
  const text = readFileSync(filePath, "utf8");
  writeFileSync(filePath, text.replaceAll(currentMetaVersion, metaVersion).replaceAll(currentVersion, releaseVersion));
}
const bumpedLockfile = readFileSync(path.join(repositoryRoot, "package-lock.json"), "utf8");
run("npm", ["install", "--package-lock-only", "--offline", "--ignore-scripts"]);
if (readFileSync(path.join(repositoryRoot, "package-lock.json"), "utf8") !== bumpedLockfile) {
  throw new Error("npm rewrote package-lock.json beyond the version bump; resolve it before releasing");
}
run("git", ["commit", "--quiet", "--all", "--message", `chore(release): ${releaseVersion} fork packages\n\n${releaseNotes}`]);

for (const directory of BUILT_DIRECTORIES) {
  rmSync(path.join(repositoryRoot, directory, "dist"), { recursive: true, force: true });
}
run("npm", ["run", "build"]);
run("npm", ["run", "build:plugins"]);

const manifests = new Map(PACKAGE_DIRECTORIES.map((directory) => [directory, readManifest(directory)]));
const tarballName = (manifest: Manifest) => `${manifest.name.replace("@", "").replace("/", "-")}-${manifest.version}.tgz`;
const releaseUrls = new Map(
  [...manifests.values()].map((manifest) => [
    manifest.name,
    `https://github.com/${FORK_REPOSITORY}/releases/download/${releaseTag}/${tarballName(manifest)}`,
  ]),
);
const pinWorkspacePackages = (dependencies: Record<string, string> | undefined, pin: (url: string) => string) =>
  dependencies &&
  Object.fromEntries(
    Object.entries(dependencies).map(([name, range]) => {
      const url = releaseUrls.get(name);
      return [name, url === undefined ? range : pin(url)];
    }),
  );
const exportTargets = (exportsField: unknown): string[] => {
  if (typeof exportsField === "string") {
    return [exportsField];
  }
  if (exportsField === null || typeof exportsField !== "object") {
    return [];
  }
  return Object.values(exportsField).flatMap(exportTargets);
};
const entryTargets = (manifest: Manifest) =>
  [manifest.main, ...Object.values(manifest.bin ?? {}), ...exportTargets(manifest.exports)]
    .filter((target): target is string => target !== undefined)
    .map((target) => target.replace(/^\.\//, ""))
    .filter((target) => !target.startsWith("node_modules/") && !target.includes("*"));

const outputDirectory = mkdtempSync(path.join(tmpdir(), `sudocode-${releaseTag}-`));
process.on("exit", (exitCode) => {
  if (exitCode !== 0) {
    console.error(`release tarballs kept in ${outputDirectory}`);
  }
});
for (const [directory, manifest] of manifests) {
  const source = path.join(repositoryRoot, directory);
  const staging = path.join(outputDirectory, "staging", directory);
  for (const entry of [...(manifest.files ?? []), "README.md", "LICENSE"]) {
    const entryRoot = entry.replace(/\/\*\*\/\*$/, "");
    if (existsSync(path.join(source, entryRoot))) {
      cpSync(path.join(source, entryRoot), path.join(staging, entryRoot), { recursive: true });
    }
  }
  const packedManifest = {
    ...manifest,
    dependencies: pinWorkspacePackages(manifest.dependencies, (url) => url),
    peerDependencies: pinWorkspacePackages(manifest.peerDependencies, () => releaseVersion),
  };
  writeFileSync(path.join(staging, "package.json"), `${JSON.stringify(packedManifest, null, 2)}\n`);
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", outputDirectory], staging);
  const packed = new Set(run("tar", ["-tzf", path.join(outputDirectory, tarballName(manifest))]).split("\n"));
  const missing = entryTargets(manifest).filter((target) => !packed.has(`package/${target}`));
  if (missing.length > 0) {
    throw new Error(`${tarballName(manifest)} is missing its entry points: ${missing.join(", ")}`);
  }
}

run("git", ["tag", "--annotate", releaseTag, "--message", releaseTag]);
run("git", ["push", "--atomic", "--quiet", forkRemote, `release/${releaseTag}`, releaseTag]);
const tarballs = [...manifests.values()].map((manifest) => path.join(outputDirectory, tarballName(manifest)));
const releaseUrl = run("gh", ["release", "create", releaseTag, "--repo", FORK_REPOSITORY, "--verify-tag", "--title", releaseTag, "--notes-file", notesPath, ...tarballs]);
rmSync(outputDirectory, { recursive: true, force: true });
console.log(`${releaseUrl}\npin: ${releaseUrls.get("sudocode")} (version ${metaVersion})`);

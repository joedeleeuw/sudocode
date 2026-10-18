import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const TRACKED_PROJECT_FILES = ["config.json", "issues.jsonl", "specs.jsonl"];

export class ProjectNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectNotFoundError";
  }
}

export function repositoryRoot(directory: string): string {
  const revParse = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: directory,
    encoding: "utf8",
  });
  if (revParse.error) {
    throw revParse.error;
  }
  if (revParse.status !== 0) {
    throw new ProjectNotFoundError(
      `${directory} is not inside a git repository. A sudocode project lives at the root of a git repository.` +
        projectsBelow(directory)
    );
  }
  return revParse.stdout.trim();
}

export function projectDirectory(directory: string): string {
  const root = repositoryRoot(directory);
  const sudocodeDir = path.join(root, ".sudocode");
  if (isProject(sudocodeDir)) {
    return sudocodeDir;
  }
  throw new ProjectNotFoundError(
    `No sudocode project at ${sudocodeDir}. Run \`sudocode init\` in ${root} to create one.` +
      projectsBelow(directory)
  );
}

function isProject(sudocodeDir: string): boolean {
  return TRACKED_PROJECT_FILES.some((file) =>
    fs.existsSync(path.join(sudocodeDir, file))
  );
}

function projectsBelow(directory: string): string {
  const projects = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        isProject(path.join(directory, entry.name, ".sudocode"))
    )
    .map((entry) => `  ${path.join(directory, entry.name)}`);
  if (projects.length === 0) {
    return "";
  }
  return `\nProjects in ${directory}:\n${projects.join("\n")}`;
}

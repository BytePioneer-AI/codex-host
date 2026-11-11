import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const MAX_PROJECTS = 200;
const MAX_DIRECTORIES = 2_000;
const MAX_DEPTH = 3;
const SKIP = new Set(["node_modules", "target", "dist", "build", "vendor", "Pods", "venv"]);
const MANIFESTS: Record<string, string> = {
  "package.json": "node",
  "Cargo.toml": "rust",
  "pyproject.toml": "python",
  "requirements.txt": "python",
  "go.mod": "go",
  "Package.swift": "swift",
  "pom.xml": "java",
  "build.gradle": "java",
  "build.gradle.kts": "kotlin",
  Dockerfile: "docker",
  "compose.yaml": "docker-compose",
  "docker-compose.yml": "docker-compose",
};
const FRAMEWORKS = ["react", "next", "vue", "nuxt", "svelte", "astro", "vite", "express"];

export interface ProjectSummary {
  name: string;
  cwd: string;
  description?: string;
  technologies: string[];
  manifests: string[];
  branch?: string;
  remote?: string;
}

export interface ProjectScan {
  projects: ProjectSummary[];
  unavailableRoots: string[];
  truncated: boolean;
  observedAt: string;
}

/** Reads a small regular manifest without following a symlink or executing project code. */
async function packageMetadata(file: string): Promise<Record<string, unknown> | undefined> {
  if (!(await lstat(file).catch(() => undefined))?.isFile()) return undefined;
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  ).catch(() => undefined);
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 65_536) return undefined;
    const bytes = Buffer.alloc(info.size);
    await handle.read(bytes, 0, bytes.length, 0);
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

function git(
  cwd: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", cwd, ...args],
      { env: environment, timeout: 1_500, maxBuffer: 32_768, windowsHide: true },
      (error, stdout) => resolve(error ? undefined : stdout.trim()),
    );
  });
}

/** Repository identity does not include embedded credentials, query strings or fragments. */
export function repositoryRemote(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (path.isAbsolute(value) || /^[a-z]:[\\/]/iu.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    const scp = /^(?:[^@\s]+@)?([a-z0-9.-]+):([^?#\\\s]+)(?:[?#].*)?$/iu.exec(value);
    return scp ? `${scp[1]}:${scp[2]}` : undefined;
  }
}

async function summarize(cwd: string, environment: NodeJS.ProcessEnv): Promise<ProjectSummary> {
  const entries = await readdir(cwd, { withFileTypes: true }).catch(() => []);
  const names = entries.filter((entry) => !entry.isSymbolicLink()).map((entry) => entry.name);
  const manifests = entries
    .filter((entry) => entry.isFile() && MANIFESTS[entry.name] !== undefined)
    .map((entry) => entry.name);
  const technologies = new Set(manifests.map((name) => MANIFESTS[name] as string));
  if (names.some((name) => /\.(xcodeproj|xcworkspace)$/u.test(name))) technologies.add("xcode");
  const [metadata, branch, origin] = await Promise.all([
    names.includes("package.json") ? packageMetadata(path.join(cwd, "package.json")) : undefined,
    git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], environment),
    git(cwd, ["config", "--get", "remote.origin.url"], environment),
  ]);
  const dependencies = { ...Object(metadata?.dependencies), ...Object(metadata?.devDependencies) };
  for (const framework of FRAMEWORKS) if (framework in dependencies) technologies.add(framework);
  const remote = repositoryRemote(origin);
  return {
    name: path.basename(cwd),
    cwd,
    ...(typeof metadata?.description === "string"
      ? { description: metadata.description.slice(0, 240) }
      : {}),
    technologies: [...technologies].sort(),
    manifests: manifests.sort(),
    ...(branch ? { branch } : {}),
    ...(remote ? { remote } : {}),
  };
}

/** Bounded discovery under configured roots, including Git worktrees; never scans inside a repo. */
export async function discoverProjects(
  roots: string[],
  environment: NodeJS.ProcessEnv,
): Promise<ProjectScan> {
  const queue: Array<{ cwd: string; depth: number }> = [];
  const unavailableRoots: string[] = [];
  for (const root of roots) {
    const resolved = await realpath(root).catch(() => undefined);
    if (!resolved || !(await lstat(resolved).catch(() => undefined))?.isDirectory())
      unavailableRoots.push(root);
    else if (!queue.some((entry) => entry.cwd === resolved))
      queue.push({ cwd: resolved, depth: 0 });
  }
  const seen = new Set<string>();
  const repositories: string[] = [];
  let visited = 0;
  let truncated = false;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    if (visited >= MAX_DIRECTORIES || repositories.length >= MAX_PROJECTS) {
      truncated = true;
      break;
    }
    const { cwd, depth } = queue[cursor] as { cwd: string; depth: number };
    if (seen.has(cwd)) continue;
    seen.add(cwd);
    visited += 1;
    const marker = await lstat(path.join(cwd, ".git")).catch(() => undefined);
    if (marker?.isDirectory() || marker?.isFile()) {
      repositories.push(cwd);
      continue;
    }
    const children = await readdir(cwd, { withFileTypes: true }).catch(() => undefined);
    if (!children) {
      unavailableRoots.push(cwd);
      continue;
    }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!child.isDirectory() || child.name.startsWith(".") || SKIP.has(child.name)) continue;
      if (depth >= MAX_DEPTH) {
        truncated = true;
        continue;
      }
      if (queue.length >= MAX_DIRECTORIES) {
        truncated = true;
        break;
      }
      queue.push({ cwd: path.join(cwd, child.name), depth: depth + 1 });
    }
  }
  const projects: ProjectSummary[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, repositories.length) }, async () => {
      while (next < repositories.length) {
        const cwd = repositories[next++] as string;
        projects.push(await summarize(cwd, environment));
      }
    }),
  );
  return {
    projects: projects.sort((a, b) => a.cwd.localeCompare(b.cwd)),
    unavailableRoots,
    truncated,
    observedAt: new Date().toISOString(),
  };
}

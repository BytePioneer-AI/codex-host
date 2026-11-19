import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { DelegationControlError } from "./delegation-types.js";

export const MAX_THREAD_REFS = 16;
const MAX_REF_LENGTH = 2_048;

/**
 * Validates caller references: absolute URIs, credentials removed, duplicates
 * dropped, order kept. Rejects rather than guesses when a value is not a URI.
 */
export function normalizeRefs(values: unknown): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string"))
    throw new DelegationControlError("INVALID_ARGUMENT", "refs must be a list of URIs");
  const refs: string[] = [];
  for (const value of values as string[]) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        `Reference is not an absolute URI: ${value}`,
      );
    }
    // A reference names where work came from; it never needs to carry a secret.
    url.username = "";
    url.password = "";
    const ref = url.toString();
    if (ref.length > MAX_REF_LENGTH)
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        `A reference may be at most ${MAX_REF_LENGTH} characters`,
      );
    if (!refs.includes(ref)) refs.push(ref);
  }
  if (refs.length > MAX_THREAD_REFS)
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      `A Thread may carry at most ${MAX_THREAD_REFS} references`,
    );
  return refs;
}

/** Inherited references first, then the Thread's own; own references win when the limit is reached. */
export function mergeRefs(inherited: readonly string[], own: readonly string[]): string[] {
  const kept = inherited.filter((ref) => !own.includes(ref));
  const room = Math.max(0, MAX_THREAD_REFS - own.length);
  return [...kept.slice(0, room), ...own];
}

export interface ThreadRefsStore {
  get(threadId: string): Promise<string[]>;
  /** `cwd` and `title` are kept so a listing by reference can describe each Thread. */
  set(threadId: string, refs: readonly string[], cwd?: string, title?: string): Promise<void>;
  /** Threads that carry the reference, most recently set first. */
  find(ref: string): Promise<Array<{ threadId: string; cwd?: string; title?: string }>>;
}

interface RefsFile {
  formatVersion: 1;
  threadId: string;
  refs: string[];
  cwd?: string;
  title?: string;
  updatedAt: string;
}

function parseRefsFile(text: string): RefsFile | undefined {
  const value = JSON.parse(text) as Partial<RefsFile> | null;
  if (
    value?.formatVersion !== 1 ||
    typeof value.threadId !== "string" ||
    !Array.isArray(value.refs) ||
    value.refs.some((ref) => typeof ref !== "string") ||
    typeof value.updatedAt !== "string"
  )
    return undefined;
  return value as RefsFile;
}

/** One private file per Thread, named by a hash of its id so any id is a safe file name. */
export class FileThreadRefsStore implements ThreadRefsStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async get(threadId: string): Promise<string[]> {
    try {
      return parseRefsFile(await readFile(this.#path(threadId), "utf8"))?.refs ?? [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async set(
    threadId: string,
    refs: readonly string[],
    cwd?: string,
    title?: string,
  ): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const file: RefsFile = {
      formatVersion: 1,
      threadId,
      refs: [...refs],
      ...(cwd ? { cwd } : {}),
      ...(title ? { title } : {}),
      updatedAt: new Date().toISOString(),
    };
    const target = this.#path(threadId);
    const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(file)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async find(ref: string): Promise<Array<{ threadId: string; cwd?: string; title?: string }>> {
    let names: string[];
    try {
      names = await readdir(this.#directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const matches: RefsFile[] = [];
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const file = await readFile(path.join(this.#directory, name), "utf8")
        .then(parseRefsFile)
        .catch(() => undefined);
      if (file?.refs.includes(ref)) matches.push(file);
    }
    return matches
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((file) => ({
        threadId: file.threadId,
        ...(typeof file.cwd === "string" ? { cwd: file.cwd } : {}),
        ...(typeof file.title === "string" ? { title: file.title } : {}),
      }));
  }

  #path(threadId: string): string {
    const name = createHash("sha256").update(threadId).digest("hex");
    return path.join(this.#directory, `${name}.json`);
  }
}

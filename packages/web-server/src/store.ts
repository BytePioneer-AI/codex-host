/** Small durable JSON helpers under the server data directory. */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export class DataDir {
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  path(...parts: string[]): string {
    return join(this.root, ...parts);
  }

  readJson<T>(relative: string, fallback: T): T {
    const target = this.path(relative);
    if (!existsSync(target)) return fallback;
    try {
      return JSON.parse(readFileSync(target, "utf8")) as T;
    } catch (error) {
      console.error(`[store] unreadable ${target}`, error);
      return fallback;
    }
  }

  writeJson(relative: string, value: unknown): void {
    const target = this.path(relative);
    mkdirSync(dirname(target), { recursive: true });
    const temp = `${target}.${String(process.pid)}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temp, target);
  }

  appendLine(relative: string, value: unknown): void {
    const target = this.path(relative);
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, `${JSON.stringify(value)}\n`);
  }

  writeLines(relative: string, values: readonly unknown[]): void {
    const target = this.path(relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, values.map((value) => `${JSON.stringify(value)}\n`).join(""));
  }

  readLines<T>(relative: string): T[] {
    const target = this.path(relative);
    if (!existsSync(target)) return [];
    const result: T[] = [];
    for (const line of readFileSync(target, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        result.push(JSON.parse(line) as T);
      } catch {
        // A torn final line from a crash is dropped; earlier lines stay authoritative.
      }
    }
    return result;
  }
}

/** Unwrap the Typert argument object: methods name their single parameter `request` (or `_request`). */
export function requestOf<T>(args: Record<string, unknown>): T {
  if ("request" in args) return args.request as T;
  if ("_request" in args) return args._request as T;
  return args as T;
}

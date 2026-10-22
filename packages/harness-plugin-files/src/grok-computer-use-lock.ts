import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Both preference and Grok config owners participate, including console and Host
 * processes. An abandoned lock fails closed; it is never stolen from a writer.
 */
export async function withGrokComputerUseLock<T>(
  dataDirectory: string,
  grokHome: string,
  operation: () => Promise<T>,
): Promise<T> {
  const locks = [
    ...new Set([
      path.join(dataDirectory, ".grok-computer-use.lock"),
      path.join(grokHome, ".codexhost-cua.lock"),
    ]),
  ].sort();
  const acquired: string[] = [];
  const deadline = Date.now() + 5_000;
  try {
    for (const lock of locks) {
      await mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
      for (;;) {
        try {
          await mkdir(lock, { mode: 0o700 });
          acquired.push(lock);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (Date.now() >= deadline) throw new Error("Grok Computer Use settings are locked");
          await delay(25);
        }
      }
    }
    return await operation();
  } finally {
    for (const lock of acquired.reverse()) await rm(lock, { recursive: true });
  }
}

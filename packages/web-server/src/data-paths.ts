/** Web-owned files share the Host data root without sharing its writable store. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Explicit Web --data remains independent; this is only the default. */
export function defaultWebDataDirectory(hostDataDirectory?: string): string {
  return join(resolve(hostDataDirectory ?? join(homedir(), ".codexhost")), "web");
}

/** Do not silently replace an existing legacy profile with an empty default profile. */
export function assertDefaultWebDataReady(directory: string, home = homedir()): void {
  if (existsSync(directory)) return;
  const legacy = [".codexhost-web-preview", ".codexhost-web"]
    .map((name) => join(home, name))
    .filter((candidate) => existsSync(candidate));
  if (legacy.length) {
    throw new Error(
      `Existing Web data found at ${legacy.join(", ")}; migrate the chosen profile offline to ${directory}, or pass --data explicitly. No data was moved.`,
    );
  }
}

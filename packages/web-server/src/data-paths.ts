/** Web-owned files share the Host data root without sharing its writable store. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Explicit Web --data remains independent; this is only the default. */
export function defaultWebDataDirectory(hostDataDirectory?: string): string {
  return join(resolve(hostDataDirectory ?? join(homedir(), ".codexhost")), "web");
}

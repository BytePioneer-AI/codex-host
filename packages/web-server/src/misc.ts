/** Small Remote endpoints the composed plugins read at boot. */

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { requestOf } from "./store.ts";
import { type EventHub, RpcError, type RpcRegistry } from "./transport.ts";

export function registerMisc(rpc: RpcRegistry, deps: { events: EventHub }): void {
  rpc.register("$events/result", (args) => deps.events.settle(requestOf(args)));
  rpc.register("credentials/describe", (args) => {
    const refs = (args.refs as string[] | undefined) ?? [];
    return Object.fromEntries(
      refs.map((ref) => [ref, { configured: true, source: "env", writable: false }]),
    );
  });
  rpc.register("skills/list", () => ({ skills: [] }));
  rpc.register("llm/listProviders", () => []);
  rpc.register("llm/listConfigurableProviders", () => []);

  // Browse-style directory picker so remote and mobile browsers can choose Host folders.
  rpc.register("directoryPicker/list", (args) => {
    const requested = typeof args.path === "string" && args.path !== "" ? args.path : homedir();
    const target = resolve(
      requested.startsWith("~") ? join(homedir(), requested.slice(1)) : requested,
    );
    const LIMIT = 2000;
    try {
      const all = readdirSync(target, { withFileTypes: true })
        .filter((entry) => {
          try {
            return (
              entry.isDirectory() ||
              (entry.isSymbolicLink() && statSync(join(target, entry.name)).isDirectory())
            );
          } catch {
            return false;
          }
        })
        .map((entry) => ({
          name: entry.name,
          path: join(target, entry.name),
          hidden: entry.name.startsWith("."),
        }))
        .sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.name.localeCompare(b.name));
      const crumbs: Array<{ name: string; path: string; hidden: boolean }> = [];
      let cursor = target;
      for (;;) {
        crumbs.unshift({
          name: cursor === dirname(cursor) ? cursor : (cursor.split(sep).pop() ?? cursor),
          path: cursor,
          hidden: false,
        });
        const parent = dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
      }
      return {
        path: target,
        home: homedir(),
        crumbs,
        entries: all.slice(0, LIMIT),
        truncated: all.length > LIMIT,
      };
    } catch {
      throw new RpcError("directory-picker/unreadable", `Cannot read ${target}`, { path: target });
    }
  });
  rpc.register("directoryPicker/createDirectory", (args) => {
    const parent = String(args.path ?? "");
    const name = String(args.name ?? "").trim();
    if (name === "" || name.includes("/") || name === "." || name === "..") {
      throw new RpcError("gateway/bad-request", "Folder name must be a single path segment", {});
    }
    const target = join(parent, name);
    if (existsSync(target))
      throw new RpcError("directory-picker/exists", `${target} already exists`, { path: target });
    try {
      mkdirSync(target);
    } catch {
      throw new RpcError("directory-picker/create-failed", `Cannot create ${target}`, {
        path: target,
      });
    }
    return target;
  });
  rpc.register("directoryPicker/pick", () => {
    throw new RpcError(
      "directory-picker/unavailable",
      "Native folder picker is unavailable in the Web UI",
      { capability: "native" },
    );
  });
}

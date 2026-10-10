/** Client UI settings namespaces (`settings/*`), persisted per server data directory. */

import fixtureNamespaces from "../fixtures/settings-namespaces.json" with { type: "json" };

import type { DataDir } from "./store.ts";
import { type EventHub, RpcError, type RpcRegistry } from "./transport.ts";

interface Namespace {
  ns: string;
  autoGenerate: boolean;
  schema: unknown;
  value: Record<string, unknown>;
  base: Record<string, unknown>;
  user: Record<string, unknown>;
  applies: string;
  secrets: unknown[];
  revision: number;
}

type Op = { op: "set"; path: string[]; value: unknown } | { op: "unset"; path: string[] };

const FILE = "settings.json";

function merge(
  base: Record<string, unknown>,
  user: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(user)) {
    const prior = result[key];
    result[key] =
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof prior === "object" &&
      prior !== null &&
      !Array.isArray(prior)
        ? merge(prior as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return result;
}

function applyOp(target: Record<string, unknown>, op: Op): void {
  if (op.path.length === 0) {
    if (op.op === "set" && typeof op.value === "object" && op.value !== null) {
      for (const key of Object.keys(target)) Reflect.deleteProperty(target, key);
      Object.assign(target, op.value);
    }
    return;
  }
  let cursor = target;
  for (const key of op.path.slice(0, -1)) {
    const next = cursor[key];
    if (typeof next !== "object" || next === null) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  const last = op.path.at(-1) as string;
  if (op.op === "set") cursor[last] = op.value;
  else Reflect.deleteProperty(cursor, last);
}

export class Settings {
  private readonly namespaces = new Map<string, Namespace>();

  constructor(
    private readonly data: DataDir,
    private readonly events: EventHub,
  ) {
    const fixtures = structuredClone(fixtureNamespaces) as unknown as Namespace[];
    const stored = data.readJson<
      Record<string, { user: Record<string, unknown>; revision: number }>
    >(FILE, {});
    for (const fixture of fixtures) {
      const saved = stored[fixture.ns];
      const user = saved?.user ?? {};
      this.namespaces.set(fixture.ns, {
        ...fixture,
        user,
        revision: saved?.revision ?? 0,
        value: merge(fixture.base, user),
      });
    }
  }

  private save(): void {
    const out: Record<string, { user: Record<string, unknown>; revision: number }> = {};
    for (const ns of this.namespaces.values())
      out[ns.ns] = { user: ns.user, revision: ns.revision };
    this.data.writeJson(FILE, out);
  }

  register(rpc: RpcRegistry): void {
    rpc.register("settings/describe", () => ({
      writable: true,
      hasDocument: false,
      namespaces: [...this.namespaces.values()],
    }));
    rpc.register("settings/mutate", (args) => {
      const request = args as { ns: string; ops: Op[]; expectedRevision?: number };
      const ns = this.namespaces.get(request.ns);
      if (ns === undefined)
        throw new RpcError(
          "settings/unknown-namespace",
          `Unknown settings namespace ${request.ns}`,
          { ns: request.ns },
        );
      if (request.expectedRevision !== undefined && request.expectedRevision !== ns.revision) {
        throw new RpcError("settings/revision-conflict", "Settings changed elsewhere", {
          ns: request.ns,
          revision: ns.revision,
        });
      }
      for (const op of request.ops) applyOp(ns.user, op);
      ns.revision += 1;
      ns.value = merge(ns.base, ns.user);
      this.save();
      this.events.emit("settings/document-updated", ns.ns, ns.revision);
      return ns;
    });
  }
}

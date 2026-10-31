import { isAbsolute, resolve } from "node:path";
import { stat } from "node:fs/promises";
import {
  harnessModelCatalogSchema,
  nativeSessionRefSchema,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";
import type { HarnessModelCatalog } from "@codexhost/harness-adapter";
import { resolveTrae } from "./command.js";
import { catalogFrom } from "./configuration.js";
import { array, record, text, TraeError } from "./protocol.js";
import { TraeTransport, type TraeOptions } from "./transport.js";

export async function workspace(cwd: string): Promise<string> {
  if (!isAbsolute(cwd) || !(await stat(cwd).catch(() => null))?.isDirectory())
    throw new TraeError("invalidRequest", "Trae requires an existing absolute workspace directory");
  return resolve(cwd);
}
export function nativeId(value: NativeSessionRef): string {
  const ref = nativeSessionRefSchema.safeParse(value);
  if (!ref.success || ref.data.harnessId !== "trae" || ref.data.formatVersion !== 1)
    throw new TraeError(
      "invalidRequest",
      "Native Session Ref does not belong to this Trae adapter",
    );
  return ref.data.nativeSessionId;
}
export function connect(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  options: TraeOptions,
): TraeTransport {
  return new TraeTransport(
    resolveTrae(environment, options.command),
    cwd,
    environment,
    options.timeoutMs,
  );
}
export async function inspectConnection(transport: TraeTransport): Promise<HarnessModelCatalog> {
  await transport.initialize();
  const account = record(await transport.call("account/read", { refreshToken: false }));
  if (account.requiresOpenaiAuth === true && !account.account)
    throw new TraeError(
      "authenticationRequired",
      "Run traecli login with an account entitled to Trae CLI",
    );
  if (typeof account.requiresOpenaiAuth !== "boolean")
    throw new TraeError("protocolError", "Incompatible Trae account response");
  const models: unknown[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = record(await transport.call("model/list", { ...(cursor ? { cursor } : {}) }));
    if (!Array.isArray(page.data))
      throw new TraeError("protocolError", "Incompatible Trae Model catalog");
    models.push(...array(page.data));
    cursor = text(page.nextCursor) || undefined;
    if (cursor && (cursors.has(cursor) || cursors.size >= 100))
      throw new TraeError("protocolError", "Invalid Trae catalog pagination");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  const catalog = harnessModelCatalogSchema.parse(catalogFrom(models));
  if (!catalog.models.length)
    throw new TraeError("configurationRequired", "Trae did not report any available Models");
  return catalog;
}

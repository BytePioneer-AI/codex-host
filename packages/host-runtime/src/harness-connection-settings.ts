import type { HarnessAdapter } from "@codexhost/harness-adapter";
import {
  HARNESS_CONNECTION_SET_METHOD,
  harnessConnectionGetSchema,
  harnessConnectionSetSchema,
  harnessConnectionStateSchema,
  jsonValueSchema,
  type JsonObject,
} from "@codexhost/shared-contracts";

/** Opaque, write-only connection material. Host neither interprets nor persists it. */
export async function handleHarnessConnectionSettings(
  method: string,
  params: unknown,
  adapters: ReadonlyMap<string, HarnessAdapter>,
): Promise<JsonObject> {
  const parsed = (
    method === HARNESS_CONNECTION_SET_METHOD
      ? harnessConnectionSetSchema
      : harnessConnectionGetSchema
  ).safeParse(params);
  if (!parsed.success)
    return { error: { code: -32602, message: "Invalid Harness connection settings" } };
  const connection = adapters.get(parsed.data.harnessId)?.connection;
  if (!connection)
    return method === HARNESS_CONNECTION_SET_METHOD
      ? { error: { code: -32601, message: "Harness connection settings are unavailable" } }
      : { result: { supported: false } };
  try {
    const setting =
      method === HARNESS_CONNECTION_SET_METHOD
        ? harnessConnectionSetSchema.parse(params)
        : undefined;
    const result = setting
      ? await (setting.cwd !== undefined
          ? connection.set(setting.secret, setting.cwd)
          : connection.set(setting.secret))
      : await connection.get();
    // A plugin may accidentally echo a submitted secret in either an error body or stack.
    if (!result.ok)
      return {
        error: { code: -32076, message: "Could not read or save Harness connection settings" },
      };
    return { result: jsonValueSchema.parse(harnessConnectionStateSchema.parse(result.value)) };
  } catch {
    return {
      error: { code: -32076, message: "Could not read or save Harness connection settings" },
    };
  }
}

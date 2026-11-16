import { execFile } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { Transform, type TransformCallback } from "node:stream";
import type { JsonObject, JsonValue } from "@codexhost/protocol-core";
import { parseJsonFrame } from "@codexhost/protocol-core";

type RegisterServer = (server: JsonObject, cwd?: string) => JsonObject | undefined;

function object(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Rewrites only Desktop-provided MCP definitions understood by the local bridge. */
export function rewriteDesktopMcpRequest(
  message: JsonObject,
  register: RegisterServer,
): JsonObject {
  const params = message.params;
  if (!object(params)) return message;
  const request = object(params.request) ? params.request : params;
  const cwd = typeof request.cwd === "string" ? request.cwd : undefined;
  function server(value: JsonValue): JsonValue {
    return object(value) ? (register(value, cwd) ?? value) : value;
  }
  function servers(value: JsonValue): JsonValue {
    if (!object(value)) return value;
    let changed = false;
    const entries = Object.entries(value).map(([key, current]) => {
      const next = server(current);
      changed ||= next !== current;
      return [key, next];
    });
    return changed ? Object.fromEntries(entries) : value;
  }
  function entry(key: string, value: JsonValue): JsonValue {
    if (key === "mcp_servers") return servers(value);
    if (/^mcp_servers\.[^.]+$/u.test(key)) return server(value);
    return value;
  }
  if (
    ["thread/start", "thread/resume", "thread/fork"].includes(String(message.method)) &&
    object(request.config)
  ) {
    let changed = false;
    const config = Object.fromEntries(
      Object.entries(request.config).map(([key, value]) => {
        const next = entry(key, value);
        changed ||= next !== value;
        return [key, next];
      }),
    );
    if (!changed) return message;
    return {
      ...message,
      params:
        request === params ? { ...params, config } : { ...params, request: { ...request, config } },
    };
  }
  return message;
}

/** Leaves unowned frames and unterminated trailing bytes byte-for-byte intact. */
export class DesktopMcpConfigTransform extends Transform {
  readonly #register: RegisterServer;
  #chunks: Buffer[] = [];
  #length = 0;

  constructor(register: RegisterServer) {
    super();
    this.#register = register;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    let start = 0;
    let end: number;
    while ((end = chunk.indexOf(0x0a, start)) >= 0) {
      const tail = chunk.subarray(start, end);
      const frame = this.#length
        ? Buffer.concat([...this.#chunks, tail], this.#length + tail.length)
        : tail;
      this.#chunks = [];
      this.#length = 0;
      let output = frame;
      try {
        const value = parseJsonFrame(frame);
        if (object(value)) {
          const next = rewriteDesktopMcpRequest(value, this.#register);
          if (next !== value) output = Buffer.from(JSON.stringify(next));
        }
      } catch {
        // Unknown framing and configuration remain the official backend's input.
      }
      this.push(output);
      this.push(Buffer.from("\n"));
      start = end + 1;
    }
    if (start < chunk.length) {
      const tail = chunk.subarray(start);
      this.#chunks.push(tail);
      this.#length += tail.length;
    }
    callback();
  }

  override _flush(callback: TransformCallback): void {
    for (const chunk of this.#chunks) this.push(chunk);
    this.#chunks = [];
    this.#length = 0;
    callback();
  }
}

export const desktopStdioConfig = z
  .object({
    command: z.string(),
    url: z.undefined().optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    env_vars: z
      .array(
        z.union([
          z.string(),
          z
            .object({ name: z.string(), source: z.literal("local").default("local") })
            .transform(({ name }) => name),
        ]),
      )
      .default([]),
    cwd: z.string().optional(),
    environment_id: z.literal("local").optional(),
  })
  .loose();

function tomlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== null)
      .map(([key, entry]) => `${JSON.stringify(key)}=${tomlValue(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Retains plugin tool policy when native CLI overrides materialize its stdio entry. */
async function bundledServerPolicy(
  name: string,
  definition: JsonObject,
  environment: NodeJS.ProcessEnv,
): Promise<JsonObject> {
  const selected = desktopStdioConfig.safeParse(definition);
  if (!selected.success) return {};
  const version = selected.data.env.BROWSER_USE_CODEX_APP_VERSION;
  if (!version || !/^[a-zA-Z0-9._-]+$/u.test(version)) return {};
  const cache = path.join(
    environment.CODEX_HOME ?? path.join(environment.HOME ?? homedir(), ".codex"),
    "plugins",
    "cache",
    "openai-bundled",
  );
  const fingerprint = (value: z.infer<typeof desktopStdioConfig>) => [
    value.command,
    value.args,
    value.env,
    value.env_vars,
    value.cwd ?? null,
  ];
  for (const plugin of await readdir(cache).catch(() => [])) {
    try {
      const manifest = z
        .object({ mcpServers: z.record(z.string(), z.record(z.string(), z.json())) })
        .parse(JSON.parse(await readFile(path.join(cache, plugin, version, ".mcp.json"), "utf8")));
      const config = manifest.mcpServers[name];
      const candidate = desktopStdioConfig.safeParse(config);
      if (
        candidate.success &&
        isDeepStrictEqual(fingerprint(candidate.data), fingerprint(selected.data))
      )
        return config ?? {};
    } catch {
      // Only an installed definition matching the native effective transport contributes policy.
    }
  }
  return {};
}

/** Reads native configuration without persisting ephemeral Desktop transport credentials. */
export async function desktopNativeMcpOverrides(
  native: { executable: string; arguments: readonly string[] } | undefined,
  environment: NodeJS.ProcessEnv,
  register: RegisterServer,
): Promise<string[]> {
  const overrides: string[] = [];
  try {
    if (native) {
      const configArguments: string[] = [];
      const flags = ["-c", "--config", "-p", "--profile", "--enable", "--disable"];
      for (let i = 0; i < native.arguments.length; i++) {
        const argument = native.arguments[i];
        if (argument && flags.includes(argument) && native.arguments[i + 1] !== undefined) {
          configArguments.push(argument, String(native.arguments[++i]));
        } else if (argument && flags.some((flag) => argument.startsWith(`${flag}=`))) {
          configArguments.push(argument);
        }
      }
      const invocation = { env: environment, timeout: 15_000, maxBuffer: Number.MAX_SAFE_INTEGER };
      const [result, globalResult] = await Promise.all([
        promisify(execFile)(
          native.executable,
          [...configArguments, "mcp", "list", "--json"],
          invocation,
        ),
        promisify(execFile)(
          native.executable,
          [...configArguments, "-c", "features.plugins=false", "mcp", "list", "--json"],
          invocation,
        ),
      ]);
      const globalNames = new Set(
        z
          .array(z.object({ name: z.string() }))
          .parse(JSON.parse(globalResult.stdout))
          .map((server) => server.name),
      );
      const servers: unknown = JSON.parse(result.stdout);
      const listed = z
        .array(
          z.object({
            name: z.string(),
            enabled: z.boolean(),
            transport: z.record(z.string(), z.json()),
            startup_timeout_sec: z.number().nullable().optional(),
            tool_timeout_sec: z.number().nullable().optional(),
          }),
        )
        .parse(servers);
      for (const server of listed) {
        if (
          !server.enabled ||
          !/^[a-zA-Z0-9_-]+$/u.test(server.name) ||
          server.transport.type !== "stdio"
        )
          continue;
        const definition = Object.fromEntries(
          Object.entries(server.transport).filter(
            ([key, value]) => key !== "type" && value !== null,
          ),
        );
        const policy: JsonObject = globalNames.has(server.name)
          ? {}
          : await bundledServerPolicy(server.name, definition, environment);
        if (!globalNames.has(server.name) && Object.keys(policy).length === 0) continue;
        const adapted = register(
          definition,
          environment.CODEX_HOME ?? path.join(environment.HOME ?? homedir(), ".codex"),
        );
        if (!adapted) continue;
        const fields = {
          ...policy,
          startup_timeout_sec: server.startup_timeout_sec ?? policy.startup_timeout_sec,
          tool_timeout_sec: server.tool_timeout_sec ?? policy.tool_timeout_sec,
          command: adapted.command,
          args: adapted.args,
        };
        for (const [key, value] of Object.entries(fields)) {
          if (
            value === undefined ||
            value === null ||
            ["env", "env_vars", "cwd", "environment_id"].includes(key)
          )
            continue;
          overrides.push("-c", `mcp_servers.${server.name}.${key}=${tomlValue(value)}`);
        }
      }
    }
  } catch {
    process.stderr.write("codexhost: Desktop browser MCP configuration could not be read\n");
  }
  return overrides;
}

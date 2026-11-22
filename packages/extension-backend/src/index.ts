import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import type { HostExtensionBackendContext } from "@codexhost/shared-contracts";

export type ExtensionBackendEntry = Pick<
  HostExtensionBackendContext,
  "extensionId" | "extensionDir" | "dataDir"
> & {
  url: string;
  hash: string;
  installation: string;
};
export interface ExtensionBackendOptions {
  readSettings(): Promise<Record<string, unknown>>;
  writeSettings(values: Record<string, unknown>): Promise<Record<string, unknown>>;
  diagnose?(message: string): void;
  /** Explicit child environment; omitted means no inherited application secrets. */
  env?: NodeJS.ProcessEnv;
}

type Command =
  | { op: "activate"; entry: ExtensionBackendEntry }
  | { op: "invoke"; method: string; params: unknown }
  | { op: "dispose" };
type Reply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };
type Settings = { op: "read" } | { op: "write"; values: Record<string, unknown> };

type BackendExports = { activate?: (context: HostExtensionBackendContext) => unknown };

const MAX_IPC_BYTES = 2 * 1024 * 1024;
const MAX_SETTINGS_IN_FLIGHT = 4;
export const BACKEND_ENTRY_CHANGED = "Backend entry changed since discovery";
const IPC_ERRORS = {
  invalidJson: "Backend IPC message is not JSON-serializable",
  tooLarge: "Backend IPC message exceeds 2 MiB",
  settingsLimit: `Too many pending backend settings requests (limit: ${MAX_SETTINGS_IN_FLIGHT})`,
};

/** Return only Host-defined IPC errors, not arbitrary extension error details. */
export function backendIpcErrorMessage(error: unknown): string | undefined {
  return error instanceof Error
    ? Object.values(IPC_ERRORS).find((message) => message === error.message)
    : undefined;
}

// Self-contained child entry point: the release Host ships as a single ESM bundle.
function backendChild(
  importEntry: (url: string) => Promise<BackendExports & { default?: BackendExports }>,
  maxIpcBytes: number,
  maxSettingsInFlight: number,
  errors: typeof IPC_ERRORS,
  entryChanged: string,
) {
  const pendingSettings = new Map<
    number,
    { resolve(value: Record<string, unknown>): void; reject(error: Error): void }
  >();
  const handlers = new Map<string, (params: unknown) => unknown>();
  let settingsId = 0;
  let dispose: (() => unknown) | undefined;
  const send = (message: Reply | { settings: Settings & { id: number } }) => {
    let text: string;
    try {
      text = JSON.stringify(message, (_key, value: unknown) => {
        if (
          value === undefined ||
          typeof value === "function" ||
          typeof value === "symbol" ||
          (typeof value === "number" && !Number.isFinite(value))
        )
          throw new TypeError("Not a JSON value");
        return value;
      });
    } catch {
      throw new TypeError(errors.invalidJson);
    }
    if (Buffer.byteLength(text) > maxIpcBytes) throw new RangeError(errors.tooLarge);
    // Send the checked JSON, not the original object (getters/toJSON may change it).
    if (!process.send || !process.connected) throw new Error("Backend IPC channel is closed");
    process.send(text, undefined, undefined, () => undefined);
  };
  const settings = (command: Settings) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (pendingSettings.size >= maxSettingsInFlight) {
        reject(new Error(errors.settingsLimit));
        return;
      }
      const id = ++settingsId;
      pendingSettings.set(id, { resolve, reject });
      try {
        send({ settings: { ...command, id } });
      } catch (error) {
        pendingSettings.delete(id);
        reject(error);
      }
    });
  const loadEntry = async ({ url, hash, installation, extensionDir }: ExtensionBackendEntry) => {
    const { registerHooks } = process.getBuiltinModule("node:module");
    const { createHash } = process.getBuiltinModule("node:crypto");
    const { statSync } = process.getBuiltinModule("node:fs");
    let checked = false;
    // Hash the loader's exact entry bytes before evaluation, without a second file open.
    const hook = registerHooks({
      load(resolved, context, nextLoad) {
        if (checked) return nextLoad(resolved, context);
        if (resolved !== url) throw new Error(entryChanged);
        const result = nextLoad(resolved, context);
        const bytes = result.source;
        const info = statSync(extensionDir, { bigint: true, throwIfNoEntry: false });
        if (
          bytes == null ||
          !info ||
          `${info.dev}:${info.ino}` !== installation ||
          createHash("sha256")
            .update(bytes instanceof ArrayBuffer ? Buffer.from(bytes) : bytes)
            .digest("hex") !== hash
        )
          throw new Error(entryChanged);
        checked = true;
        return result;
      },
    });
    try {
      return await importEntry(url);
    } catch (error) {
      if (
        !checked &&
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ERR_MODULE_NOT_FOUND")
      )
        throw new Error(entryChanged);
      throw error;
    } finally {
      hook.deregister();
    }
  };
  const run = async (command: Command): Promise<unknown> => {
    if (command.op === "activate") {
      const { extensionId, extensionDir, dataDir } = command.entry;
      const module = await loadEntry(command.entry);
      const owner = typeof module.activate === "function" ? module : module.default;
      if (typeof owner?.activate !== "function")
        throw new Error("Expected an activate(ctx) export");
      let registering = true;
      const context: HostExtensionBackendContext = {
        extensionId,
        extensionDir,
        dataDir,
        readSettings: () => settings({ op: "read" }),
        writeSettings: (values) => settings({ op: "write", values }),
        handle: (method, handler) => {
          if (!registering) throw new Error("Register handlers during activate(ctx)");
          if (
            typeof method !== "string" ||
            !method.trim() ||
            method.trim().length > 128 ||
            typeof handler !== "function"
          )
            throw new Error("Invalid backend method or handler");
          const name = method.trim();
          if (handlers.has(name)) throw new Error(`Duplicate backend method: ${name}`);
          handlers.set(name, handler);
        },
      };
      try {
        const result = await owner.activate(context);
        if (typeof result === "function") dispose = () => result();
        else if (
          result &&
          typeof result === "object" &&
          "dispose" in result &&
          typeof result.dispose === "function"
        )
          dispose = result.dispose.bind(result);
        return [...handlers.keys()];
      } finally {
        registering = false;
      }
    }
    if (command.op === "dispose") {
      handlers.clear();
      await dispose?.();
      return null;
    }
    const handler = handlers.get(command.method);
    if (!handler) throw new Error("Backend method is not registered");
    return (await handler(command.params)) ?? null;
  };
  process.on("disconnect", () => {
    // The IPC owner vanished without running its exit hooks.
    if (process.platform === "win32") {
      const { spawnSync } = process.getBuiltinModule("node:child_process");
      const path = process.getBuiltinModule("node:path");
      spawnSync(
        path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
        ["/PID", String(process.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore", timeout: 2_000 },
      );
    } else {
      process.kill(-process.pid, "SIGKILL");
    }
    process.exit();
  });
  process.on("message", async (message: string | { reply: Reply }) => {
    if (typeof message !== "string") {
      const reply = message.reply;
      const pending = pendingSettings.get(reply.id);
      if (!pending) return;
      pendingSettings.delete(reply.id);
      if (reply.ok) pending.resolve(reply.value as Record<string, unknown>);
      else pending.reject(new Error(reply.error));
      return;
    }
    const command: Command & { id: number } = JSON.parse(message);
    try {
      const value = await run(command);
      send({ id: command.id, ok: true, value });
    } catch (error) {
      if (!process.connected) return;
      const details =
        error instanceof Error && typeof error.message === "string"
          ? error.message
          : "Backend threw a non-Error value";
      send({ id: command.id, ok: false, error: details.slice(0, 512) });
    }
  });
}

// One exit listener regardless of the number of extensions. Host signals go
// through the owner's normal async shutdown, which awaits stop() first.
const reapOnExit = new Set<() => void>();
const reapAll = () => {
  for (const reap of reapOnExit) reap();
};

export class ExtensionBackendProcess {
  readonly #child;
  readonly #closed: Promise<void>;
  readonly #pending = new Map<number, (reply: Reply) => void>();
  readonly #settings = new Set<Promise<unknown>>();
  #nextId = 0;
  #stopping = false;
  #activated = false;
  #reaped = false;
  #stop: Promise<void> | undefined;
  readonly #methods = new Set<string>();

  constructor(options: ExtensionBackendOptions) {
    this.#child = spawn(
      process.execPath,
      [
        "--unhandled-rejections=strict",
        "--max-old-space-size=128",
        "--input-type=module",
        "--eval",
        `(${backendChild.toString()})(url => import(url), ${MAX_IPC_BYTES}, ${MAX_SETTINGS_IN_FLIGHT}, ${JSON.stringify(IPC_ERRORS)}, ${JSON.stringify(BACKEND_ENTRY_CHANGED)})`,
      ],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        serialization: "advanced",
        env: { SystemRoot: process.env.SystemRoot, ...options.env, NODE_OPTIONS: undefined },
        detached: process.platform !== "win32",
        windowsHide: true,
      },
    );
    if (!reapOnExit.size) process.on("exit", reapAll);
    reapOnExit.add(this.#killTree);
    this.#closed = new Promise((resolve) =>
      this.#child.once("close", () => {
        reapOnExit.delete(this.#killTree);
        if (!reapOnExit.size) process.off("exit", reapAll);
        resolve();
      }),
    );
    const failed = (message: string) => {
      this.#methods.clear();
      for (const [id, finish] of this.#pending) finish({ id, ok: false, error: message });
      if (!this.#stopping) options.diagnose?.(message);
    };
    this.#child.on("error", (error) => failed(error.message));
    this.#child.on("exit", (code, signal) => {
      this.#killTree();
      failed(`Backend exited (${signal ?? code})`);
    });
    this.#child.on("message", (text: unknown) => {
      if (typeof text !== "string" || Buffer.byteLength(text) > MAX_IPC_BYTES) return;
      let message: Reply | { settings: Settings & { id: number } };
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (!message || typeof message !== "object") return;
      if (!("settings" in message)) {
        this.#pending.get(message.id)?.(message);
        return;
      }
      const request = message.settings;
      if (!request || !["read", "write"].includes(request.op)) return;
      if (this.#settings.size >= MAX_SETTINGS_IN_FLIGHT) {
        this.#sendSettingsReply({
          id: request.id,
          ok: false,
          error: IPC_ERRORS.settingsLimit,
        });
        return;
      }
      const task = Promise.resolve()
        .then(() =>
          request.op === "read" ? options.readSettings() : options.writeSettings(request.values),
        )
        .then(
          (value) => this.#sendSettingsReply({ id: request.id, ok: true, value }),
          () =>
            this.#sendSettingsReply({
              id: request.id,
              ok: false,
              error: "Could not read or save backend settings",
            }),
        )
        .finally(() => this.#settings.delete(task));
      this.#settings.add(task);
    });
  }

  #sendSettingsReply(reply: Reply) {
    if (this.#child.connected) this.#child.send({ reply }, () => undefined);
  }

  async activate(entry: ExtensionBackendEntry): Promise<void> {
    if (this.#activated || this.#stopping) throw new Error("Backend cannot be activated twice");
    this.#activated = true;
    const methods = await this.#request({ op: "activate", entry }, 5_000);
    if (!Array.isArray(methods) || !methods.every((method) => typeof method === "string"))
      throw new Error("Invalid backend activation response");
    if (!this.#child.connected || this.#stopping) throw new Error("Backend is not active");
    for (const method of methods) this.#methods.add(method);
  }

  invoke(method: string, params: unknown): Promise<unknown> {
    if (this.#stopping || !this.#methods.has(method))
      throw new Error("Backend method is not registered");
    if (this.#pending.size >= 32) throw new Error("Too many pending backend calls");
    return this.#request({ op: "invoke", method, params }, 10_000);
  }

  stop(): Promise<void> {
    return (this.#stop ??= this.#dispose());
  }

  async #dispose(): Promise<void> {
    this.#stopping = true;
    try {
      if (!this.#reaped && this.#child.connected) await this.#request({ op: "dispose" }, 1_000);
    } finally {
      await this.terminate();
    }
  }

  #killTree = (): void => {
    const pid = this.#child.pid;
    if (pid === undefined || this.#reaped) return;
    this.#reaped = true;
    if (process.platform !== "win32") {
      try {
        process.kill(-pid, "SIGKILL");
        return;
      } catch {
        // Fall back to the direct child if the group no longer exists.
      }
    } else if (this.#child.exitCode === null && this.#child.signalCode === null) {
      const taskkill = path.win32.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "taskkill.exe",
      );
      spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 2_000,
      });
    }
    this.#child.kill("SIGKILL");
  };

  async terminate(): Promise<void> {
    this.#stopping = true;
    this.#killTree();
    await this.#closed;
    await Promise.allSettled(this.#settings);
  }

  #request(command: Command, timeout: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.#nextId;
      let text: string;
      try {
        text = JSON.stringify({ ...command, id });
      } catch {
        throw new TypeError(IPC_ERRORS.invalidJson);
      }
      if (Buffer.byteLength(text) > MAX_IPC_BYTES) throw new RangeError(IPC_ERRORS.tooLarge);
      // Send the exact JSON checked above rather than reserializing the input.
      const finish = (reply: Reply) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        if (reply.ok) resolve(reply.value);
        else reject(new Error(reply.error));
      };
      const timer = setTimeout(() => {
        this.#methods.clear();
        this.#killTree();
        finish({ id, ok: false, error: `Backend ${command.op} timed out` });
      }, timeout);
      this.#pending.set(id, finish);
      try {
        this.#child.send(text, (error) => {
          if (error) finish({ id, ok: false, error: error.message });
        });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }
}

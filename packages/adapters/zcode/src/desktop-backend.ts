import type { HarnessConnectionState, NativeSessionRef } from "@codexhost/shared-contracts";
import type { HarnessResult, OpenSessionInput } from "@codexhost/harness-adapter";
import { DesktopClient, type DesktopService } from "./desktop-client.js";
import { DesktopConnection } from "./desktop-connection.js";
import { DesktopSettings, type DesktopConfiguration } from "./desktop-settings.js";
import { parseDesktopPairing, type DesktopPairing } from "./desktop-relay.js";
import { decodeModel, modelBackend } from "./models.js";
import { record } from "./protocol.js";
import { nativeError, ZcodeError } from "./errors.js";
import { sameWorkspaceDirectory } from "./workspace-directory.js";
import type { TransportOptions } from "./transport.js";

export type DesktopServiceFactory = (
  options: TransportOptions,
  pairing: DesktopPairing,
  settings: DesktopSettings,
) => Promise<DesktopService>;
const connect: DesktopServiceFactory = async (options, pairing, settings) => {
  const client = new DesktopClient(options, pairing);
  await client.connect(settings);
  return client;
};
export class DesktopBackend {
  readonly settings: DesktopSettings;
  #service: Promise<DesktopService> | undefined;
  #failure: Error | undefined;
  #closed = false;
  readonly #initial: Promise<DesktopConfiguration | undefined>;
  constructor(
    readonly environment: NodeJS.ProcessEnv,
    readonly factory: DesktopServiceFactory = connect,
    readonly supported = process.platform === "darwin" || factory !== connect,
  ) {
    this.settings = new DesktopSettings(environment);
    this.#initial = supported ? this.settings.read() : Promise.resolve(undefined);
    void this.#initial.catch(() => {});
  }
  async inspectionCwd(): Promise<string | undefined> {
    return (await this.#initial)?.cwd;
  }
  async target(input?: OpenSessionInput): Promise<"desktop" | "stdio"> {
    if (input && input.kind !== "create") {
      const ref = input.kind === "resume" ? input.nativeRef : input.sourceRef;
      const backend = record(ref.locator).backend;
      if (backend !== undefined && backend !== "desktop" && backend !== "stdio")
        throw new ZcodeError("invalidRequest", "Unknown ZCode Session backend");
      return backend === "desktop" ? "desktop" : "stdio";
    }
    if (input?.kind === "create" && input.model) {
      decodeModel(input.model);
      return modelBackend(input.model);
    }
    return (await this.#initial) ? "desktop" : "stdio";
  }
  async open(options: TransportOptions, environment?: NodeJS.ProcessEnv, ref?: NativeSessionRef) {
    if (this.#closed) throw new ZcodeError("invalidState", "ZCode Desktop backend is closed");
    if (!this.supported)
      throw new ZcodeError(
        "unsupported",
        "Desktop pairing requires a local macOS Host; stdio remains available elsewhere",
      );
    if (environment && Object.keys(environment).length)
      throw new ZcodeError(
        "unsupported",
        "ZCode Desktop cannot apply per-Session environment overrides or recursive delegation credentials; use the stdio backend for those operations",
      );
    const pairing = await this.#initial;
    if (!pairing)
      throw new ZcodeError(
        "authenticationRequired",
        "Pair ZCode Desktop in Connections before opening this official-account Thread",
      );
    if (!sameWorkspaceDirectory(pairing.cwd, options.cwd))
      throw new ZcodeError(
        "unsupported",
        "This Thread uses another workspace; update the native pairing workspace and restart before connecting",
      );
    const desktopId = pairing.deviceMid ?? pairing.deviceSid;
    if (ref && record(ref.locator).desktopId !== desktopId)
      throw new ZcodeError("invalidRequest", "This Thread belongs to another paired ZCode Desktop");
    if (this.#failure) throw this.#failure;
    this.#service ??= this.factory(options, pairing, this.settings)
      .then((service) => {
        service.onFault((error) => {
          this.#failure = error;
        });
        return service;
      })
      .catch((error: unknown) => {
        this.#failure =
          error instanceof ZcodeError
            ? error
            : new ZcodeError(
                "unavailable",
                "ZCode Desktop connection failed; restart the Host to retry explicitly",
              );
        throw this.#failure;
      });
    const service = await this.#service;
    if (this.#closed)
      throw new ZcodeError("invalidState", "ZCode Desktop closed during connection");
    if (service.desktopId !== desktopId)
      throw new ZcodeError(
        "invalidState",
        "ZCode pairing changed; close this Host connection before switching Desktop",
      );
    if (!sameWorkspaceDirectory(service.workspace.workspacePath, options.cwd))
      throw new ZcodeError(
        "unsupported",
        "This ZCode Relay bridge is bound to another workspace; use a separate native pairing for that workspace",
      );
    return new DesktopConnection(options, service);
  }
  readonly connection = {
    get: async (): Promise<HarnessResult<HarnessConnectionState>> => {
      if (!this.supported) return { ok: true, value: { supported: false } };
      try {
        const saved = await this.settings.read(),
          initial = await this.#initial.catch(() => undefined);
        return {
          ok: true,
          value: {
            supported: true,
            configured: Boolean(saved),
            cwd: saved?.cwd ?? null,
            restartRequired:
              Boolean(this.#failure) || JSON.stringify(saved) !== JSON.stringify(initial),
            description:
              "ZCode Desktop 3.12.3（macOS）：开启原生远程控制，粘贴连接链接并填写目标工作目录。保存后重启 codexhost；目标工作区须保持在 ZCode 中打开，验证码在 ZCode 处理。消息和工具输出经过 ZCode 官方 Relay，配对可能替换手机连接。链接私密保存在此 Host，不会返回界面。每个连接目前绑定一个工作区；Desktop Session 不支持独立环境变量及递归委派。清除后新 Thread 恢复 stdio，旧 Desktop Thread 不会自动切换后端。",
          },
        };
      } catch {
        // Keep the repair/clear controls available even when an older or damaged file cannot be parsed.
        return {
          ok: true,
          value: {
            supported: true,
            configured: true,
            restartRequired: true,
            cwd: null,
            description:
              "保存的 ZCode 配对配置不可读。请重新填写原生链接和工作目录，或清除配对，然后重启 codexhost。",
          },
        };
      }
    },
    set: async (
      secret: string | null,
      cwd?: string,
    ): Promise<HarnessResult<HarnessConnectionState>> => {
      try {
        if (this.#closed) throw new ZcodeError("invalidState", "ZCode adapter is closed");
        if (!this.supported)
          throw new ZcodeError("unsupported", "Desktop pairing is unavailable on this Host");
        if (secret !== null) parseDesktopPairing(secret);
        // Like launch settings, changes take effect in a new Host. Never hot-swap a
        // backend between the Host's environment-scope query and Session creation.
        await this.settings.set(secret, cwd);
        return this.connection.get();
      } catch (error) {
        return { ok: false, error: nativeError(error) };
      }
    },
  };
  async close() {
    this.#closed = true;
    await (await this.#service?.catch(() => undefined))?.close();
  }
}

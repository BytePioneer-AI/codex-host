import { createOpenCodeUsageStatistics } from "./usage-statistics.js";
import type {
  HarnessAdapter,
  HarnessInspection,
  HarnessResult,
  HarnessSession,
  HarnessSessionImportCapability,
  HarnessUsageStatisticsCapability,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import {
  OpenCodeAdapter as V1Adapter,
  openCodeCommandCatalog,
  type OpenCodeAdapterOptions,
  type OpenCodeAdapterDependencies,
} from "./opencode-adapter.js";
import { OpenCodeExecutableError } from "./command.js";
import { detectOpenCode } from "./version.js";
import { V2Adapter } from "./v2/adapter.js";
import { harnessId, failure } from "./v2/state.js";

/** Version routing belongs to the plugin. Native session data never crosses protocols. */
export class OpenCodeAdapter implements HarnessAdapter {
  readonly harnessId = harnessId;
  readonly commandCatalog = openCodeCommandCatalog;
  readonly #adapters = new Set<HarnessAdapter>();
  #closed = false;
  readonly usageStatistics: HarnessUsageStatisticsCapability;
  constructor(
    readonly options: OpenCodeAdapterOptions = {},
    readonly dependencies?: OpenCodeAdapterDependencies,
  ) {
    // Read-only over OpenCode's database for both protocol versions; no CLI is started.
    this.usageStatistics = createOpenCodeUsageStatistics(options.environment ?? process.env);
  }

  async #select(environment?: NodeJS.ProcessEnv, input?: OpenSessionInput) {
    if (this.#closed) throw new Error("OpenCode Adapter is closed");
    const options = {
      ...this.options,
      environment: { ...(this.options.environment ?? process.env), ...environment },
    };
    const detected = this.dependencies
      ? { executable: options.command, major: 1 as const }
      : await detectOpenCode(options);
    if (this.#closed) throw new Error("OpenCode Adapter closed during version detection");
    if (input && input.kind !== "create") {
      const ref = input.kind === "resume" ? input.nativeRef : input.sourceRef;
      const locator = ref.locator;
      const nativeMajor =
        locator && typeof locator === "object" && !Array.isArray(locator) && locator.protocol === 2
          ? 2
          : 1;
      if (nativeMajor !== detected.major)
        throw new Error(
          `This OpenCode Session requires v${nativeMajor}; selected CLI is v${detected.major}. Select the matching installation with CODEXHOST_OPENCODE_COMMAND. codexhost does not migrate histories.`,
        );
    }
    const pinned = { ...options, ...(detected.executable ? { command: detected.executable } : {}) };
    const adapter =
      detected.major === 2 ? new V2Adapter(pinned) : new V1Adapter(pinned, this.dependencies);
    this.#adapters.add(adapter);
    return adapter;
  }

  readonly sessionImport: HarnessSessionImportCapability = {
    listCandidates: () => this.#discover((imports) => imports.listCandidates()),
    resolveCandidate: (nativeSessionId) =>
      this.#discover((imports) => imports.resolveCandidate(nativeSessionId)),
  };

  /** Session import follows the selected CLI's protocol, like every other operation. */
  async #discover<T>(
    read: (imports: V2Adapter["sessionImport"]) => Promise<HarnessResult<T>>,
  ): Promise<HarnessResult<T>> {
    if (this.#closed)
      return { ok: false, error: failure("OpenCode Adapter is closed", "invalidState") };
    let adapter: HarnessAdapter | undefined;
    try {
      adapter = await this.#select();
      if (!(adapter instanceof V2Adapter))
        return {
          ok: false,
          // v1 answers per project only; there is no native listing across projects to import from.
          error: failure("OpenCode Session import requires OpenCode v2", "unsupported"),
        };
      return await read(adapter.sessionImport);
    } catch (error) {
      return {
        ok: false,
        error: this.#closed
          ? failure("OpenCode Adapter is closed", "invalidState")
          : normalize(error),
      };
    } finally {
      if (adapter) {
        await adapter.close();
        this.#adapters.delete(adapter);
      }
    }
  }

  async inspect(input: { cwd?: string; refresh?: boolean } = {}): Promise<HarnessInspection> {
    let adapter: HarnessAdapter | undefined;
    try {
      adapter = await this.#select();
      return await adapter.inspect(input);
    } catch (error) {
      return {
        status: error instanceof OpenCodeExecutableError ? "notInstalled" : "error",
        error: normalize(error),
      };
    } finally {
      if (adapter) {
        await adapter.close();
        this.#adapters.delete(adapter);
      }
    }
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    let adapter: HarnessAdapter | undefined;
    try {
      adapter = await this.#select(input.environment, input);
      const result = await adapter.open(input);
      if (!result.ok) {
        await adapter.close();
        this.#adapters.delete(adapter);
      }
      if (result.ok) {
        const owner = adapter;
        const close = result.value.close.bind(result.value);
        result.value.close = async () => {
          await close();
          this.#adapters.delete(owner);
        };
      }
      return result;
    } catch (error) {
      if (adapter) {
        await adapter.close();
        this.#adapters.delete(adapter);
      }
      return { ok: false, error: normalize(error) };
    }
  }

  async close() {
    this.#closed = true;
    await Promise.all([...this.#adapters].map((adapter) => adapter.close()));
    this.#adapters.clear();
  }
}

function normalize(error: unknown) {
  return failure(
    error instanceof Error ? error.message : String(error),
    error instanceof OpenCodeExecutableError ? "notInstalled" : "unavailable",
  );
}

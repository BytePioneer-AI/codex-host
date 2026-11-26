import type {
  HarnessAdapter,
  HarnessError,
  HarnessInspection,
  HarnessModelCatalog,
  HarnessResult,
  HarnessSession,
  InspectHarnessInput,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import { harnessIdSchema, type HarnessId } from "@codexhost/shared-contracts";

import {
  resolveOmoExecutable,
  type OmoExecutableDependencies,
  type OmoExecutableInput,
} from "./command.js";

const omoHarnessId: HarnessId = harnessIdSchema.parse("omo");

/** Model and Thinking catalogs arrive with the native protocol implementation. */
const availabilityCatalog: HarnessModelCatalog = { models: [], thinkingOptions: [] };

function closedError(): HarnessError {
  return { code: "invalidState", message: "OmO Adapter is closed", retryable: false };
}

function notInstalledError(): HarnessError {
  return {
    code: "notInstalled",
    message:
      "The omo CLI was not found. Install omo from the official guide, or set CODEXHOST_OMO_COMMAND to its executable.",
    retryable: false,
  };
}

export interface OmoAdapterOptions {
  command?: string;
  environment?: NodeJS.ProcessEnv;
  resolveExecutable?: (
    input: OmoExecutableInput,
    dependencies?: OmoExecutableDependencies,
  ) => string | undefined;
  discovery?: OmoExecutableDependencies;
}

export class OmoAdapter implements HarnessAdapter {
  readonly harnessId: HarnessId = omoHarnessId;
  readonly #command: string | undefined;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #resolveExecutable: NonNullable<OmoAdapterOptions["resolveExecutable"]>;
  readonly #discovery: OmoExecutableDependencies;
  #closePromise: Promise<void> | null = null;

  constructor(options: OmoAdapterOptions = {}) {
    this.#command = options.command;
    this.#environment = options.environment ?? process.env;
    this.#resolveExecutable = options.resolveExecutable ?? resolveOmoExecutable;
    this.#discovery = options.discovery ?? {};
  }

  /**
   * Availability inspection only: a resolvable omo executable is the whole
   * check in this build. Sessions and catalogs arrive in later implementation
   * steps; a missing CLI never reports ready.
   */
  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    void input;
    if (this.#closePromise) return { status: "unavailable", error: closedError() };
    const executable = this.#resolveExecutable(
      {
        environment: this.#environment,
        ...(this.#command ? { command: this.#command } : {}),
      },
      this.#discovery,
    );
    if (!executable) return { status: "notInstalled", error: notInstalledError() };
    return {
      status: "ready",
      catalog: availabilityCatalog,
      capabilities: {
        configuration: {
          selectModel: false,
          selectThinkingOption: false,
          selectPermissionMode: false,
          permissionModeScope: "live",
        },
        history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
      },
    };
  }

  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    void input;
    if (this.#closePromise) return { ok: false, error: closedError() };
    return {
      ok: false,
      error: {
        code: "unsupported",
        message: "OmO Sessions are not available in this build",
        retryable: false,
      },
    };
  }

  close(): Promise<void> {
    this.#closePromise ??= Promise.resolve();
    return this.#closePromise;
  }
}

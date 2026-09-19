import type { CodeBuddyClient, CodeBuddyClientFactory } from "@codexhost/adapter-codebuddy";
import { workBuddyInvocation } from "./command.js";
import {
  loadWorkBuddyLiveProductSnapshot,
  sanitizeWorkBuddyProductEnvironment,
  type WorkBuddyLiveProductSnapshot,
  type WorkBuddyProductModel,
} from "./product-models.js";

const LIVE_PRODUCT_CONFIG_ENV = "ACC_PRODUCT_CONFIG_V3";

export type WorkBuddyLiveProductSnapshotReader = (
  environment: NodeJS.ProcessEnv,
  desktopExecutable: string,
) => Promise<WorkBuddyLiveProductSnapshot | undefined>;

export class WorkBuddyLiveProductContext {
  #models: readonly WorkBuddyProductModel[] = [];
  readonly #reader: WorkBuddyLiveProductSnapshotReader;
  readonly #productModels: (() => Promise<readonly WorkBuddyProductModel[]>) | undefined;
  readonly #desktopExecutable: ((environment: NodeJS.ProcessEnv) => string) | undefined;

  constructor(options: {
    reader?: WorkBuddyLiveProductSnapshotReader;
    productModels?: () => Promise<readonly WorkBuddyProductModel[]>;
    desktopExecutable?: (environment: NodeJS.ProcessEnv) => string;
  }) {
    this.#reader = options.reader ?? loadWorkBuddyLiveProductSnapshot;
    this.#productModels = options.productModels;
    this.#desktopExecutable = options.desktopExecutable;
  }

  get models(): readonly WorkBuddyProductModel[] {
    return this.#models;
  }

  allowsModel(id: string): boolean {
    return this.#models.some((model) => model.id === id);
  }

  async environment(environment: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
    const sanitized = sanitizeWorkBuddyProductEnvironment(environment);
    try {
      if (this.#productModels) {
        this.#models = await this.#productModels();
        return sanitized;
      }
      let desktopExecutable = this.#desktopExecutable?.(sanitized);
      if (!desktopExecutable) {
        const invocation = workBuddyInvocation(environment, true, { platform: "win32" });
        if (invocation.arguments[0]?.startsWith("-")) {
          this.#models = [];
          return environment;
        }
        desktopExecutable = invocation.command;
      }
      const snapshot = await this.#reader(sanitized, desktopExecutable);
      if (!snapshot) {
        this.#models = [];
        return sanitized;
      }
      this.#models = snapshot.models;
      return { ...sanitized, [LIVE_PRODUCT_CONFIG_ENV]: snapshot.serialized };
    } catch {
      this.#models = [];
      return sanitized;
    }
  }
}

/** Defers native process creation until the live App snapshot has been resolved. */
export function withWorkBuddyLiveProduct(
  factory: CodeBuddyClientFactory,
  product: WorkBuddyLiveProductContext,
): CodeBuddyClientFactory {
  return (options) => {
    let native: Promise<CodeBuddyClient> | undefined;
    const client = () => {
      native ??= product
        .environment(options.environment)
        .then((environment) => factory({ ...options, environment }));
      return native;
    };
    return {
      initialize: async () => (await client()).initialize(),
      open: async (cwd, sessionId) => (await client()).open(cwd, sessionId),
      configure: async (sessionId, configId, value) =>
        (await client()).configure(sessionId, configId, value),
      prompt: async (sessionId, input) => (await client()).prompt(sessionId, input),
      cancel: async (sessionId) => (await client()).cancel(sessionId),
      answer: async (sessionId, toolCallId, answers) =>
        (await client()).answer(sessionId, toolCallId, answers),
      removeCopy: async () => (await client()).removeCopy?.(),
      rollback: async (sessionId, forkPointId) => {
        const resolved = await client();
        if (!resolved.rollback) throw new Error("WorkBuddy native rollback is unavailable");
        return resolved.rollback(sessionId, forkPointId);
      },
      close: async () => {
        if (native) await (await native).close();
      },
    };
  };
}

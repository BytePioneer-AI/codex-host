import { harnessModelRefSchema, type HarnessModelRef } from "@codexhost/shared-contracts";
import { type CodexAppServer, CodexRpcError } from "./rpc.ts";

export interface CodexModel {
  id: string;
  displayName: string;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
  defaultReasoningEffort: string;
  serviceTiers?: Array<{ id: string; name: string; description: string }>;
  defaultServiceTier?: string | null;
}

/** Only the native priority tier means Fast; model names and legacy speed labels do not. */
export function codexFastModel(model: CodexModel): HarnessModelRef | undefined {
  const tier = model.serviceTiers?.find((entry) => entry.id === "priority");
  if (!tier) return undefined;
  const id = `codex-fast~${Buffer.from(JSON.stringify([model.id, tier.id])).toString("base64url")}`;
  const ref = harnessModelRefSchema.safeParse({ id });
  return ref.success ? ref.data : undefined;
}

export async function readCodexModels(server: CodexAppServer): Promise<CodexModel[]> {
  const response = await server.request<{ data: CodexModel[] }>("model/list", { limit: 100 });
  const models = response.data.filter(
    (model) => !model.hidden && harnessModelRefSchema.safeParse({ id: model.id }).success,
  );
  // An opaque variant must never shadow a native Model ID.
  const ids = new Set(models.map((model) => model.id));
  return models.map((model) =>
    ids.has(codexFastModel(model)?.id ?? "") ? { ...model, serviceTiers: [] } : model,
  );
}

interface ModelSettings {
  model: string;
  serviceTier?: string | null;
}

interface ThreadModelSettings extends ModelSettings {
  effort?: string | null;
}

/** An unacknowledged settings write must not leave a usable Session with guessed state. */
export class CodexSettingsUnconfirmedError extends Error {}

/** Codex-owned conversion between opaque Host selections and native model/serviceTier settings. */
export class CodexModelSelection {
  private models: CodexModel[] = [];
  model: string | undefined;
  private serviceTier: string | null | undefined;

  constructor(private readonly server: CodexAppServer) {}

  private get supportsServiceTiers(): boolean {
    return this.models.some((model) => model.serviceTiers !== undefined);
  }

  async initialize(requested: string | undefined): Promise<Partial<ModelSettings>> {
    this.models = await readCodexModels(this.server);
    return requested === undefined ? {} : this.parameters(requested);
  }

  private parameters(id: string): ModelSettings {
    const native = this.models.find((model) => model.id === id);
    if (!native) {
      const fast = this.models.find((model) => codexFastModel(model)?.id === id);
      if (fast) return { model: fast.id, serviceTier: "priority" };
      if (id.startsWith("codex-fast~")) throw new Error("Codex Fast selection is unavailable");
    }
    harnessModelRefSchema.parse({ id });
    // Explicitly selecting the ordinary ref clears priority, including a native default.
    return { model: id, ...(this.supportsServiceTiers ? { serviceTier: null } : {}) };
  }

  confirm(settings: ModelSettings): void {
    harnessModelRefSchema.parse({ id: settings.model });
    this.model = settings.model;
    this.serviceTier = settings.serviceTier;
  }

  state(): { effectiveModel?: HarnessModelRef; resolvedModelLabel?: string } {
    if (this.model === undefined) return {};
    const model = this.models.find((entry) => entry.id === this.model);
    const fast = this.serviceTier === "priority" && model ? codexFastModel(model) : undefined;
    return {
      effectiveModel: fast ?? harnessModelRefSchema.parse({ id: this.model }),
      resolvedModelLabel: model?.displayName ?? this.model,
    };
  }

  turnParameters(): Partial<ModelSettings> {
    return {
      ...(this.model === undefined ? {} : { model: this.model }),
      ...(this.serviceTier === undefined ? {} : { serviceTier: this.serviceTier }),
    };
  }

  async select(
    threadId: string,
    id: string,
    effort: string | undefined,
  ): Promise<ThreadModelSettings> {
    const settings = this.parameters(id);
    if (!this.supportsServiceTiers) {
      // Older app-servers retain the Adapter's next-turn Model selection behavior, without Fast.
      this.model = settings.model;
      return { model: settings.model };
    }
    const confirmed = await this.update(threadId, { ...settings, ...(effort ? { effort } : {}) });
    this.confirm(confirmed);
    return confirmed;
  }

  private async update(
    threadId: string,
    settings: ThreadModelSettings,
  ): Promise<ThreadModelSettings> {
    let unsubscribe = (): void => {};
    let unsubscribeExit = (): void => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const confirmed = new Promise<ThreadModelSettings>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new CodexSettingsUnconfirmedError("Codex settings confirmation timed out")),
        15_000,
      );
      unsubscribeExit = this.server.onExit((error) => reject(error));
      unsubscribe = this.server.onNotification((method, params) => {
        if (method !== "thread/settings/updated" || params.threadId !== threadId) return;
        const value = params.threadSettings as Partial<ThreadModelSettings> | undefined;
        if (
          !harnessModelRefSchema.safeParse({ id: value?.model }).success ||
          !(value?.serviceTier === null || typeof value?.serviceTier === "string") ||
          !(value.effort === undefined || value.effort === null || typeof value.effort === "string")
        ) {
          reject(new CodexSettingsUnconfirmedError("Codex returned invalid model settings"));
          return;
        }
        // A preceding turn/start can still have a settings notification in flight.
        if (
          value.model !== settings.model ||
          (value.serviceTier ?? "default") !== (settings.serviceTier ?? "default") ||
          (settings.effort !== undefined && value.effort !== settings.effort)
        )
          return;
        resolve(value as ThreadModelSettings);
      });
    });
    try {
      // The empty RPC response acknowledges submission; the notification reports applied settings.
      const [, result] = await Promise.all([
        this.server.request("thread/settings/update", { threadId, ...settings }),
        confirmed,
      ]);
      return result;
    } catch (error) {
      if (error instanceof CodexRpcError) throw error;
      throw new CodexSettingsUnconfirmedError(
        error instanceof Error ? error.message : "Codex settings were not confirmed",
      );
    } finally {
      clearTimeout(timer);
      unsubscribe();
      unsubscribeExit();
    }
  }
}

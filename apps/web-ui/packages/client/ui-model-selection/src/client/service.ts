/**
 * ModelDirectoryResolver (`ctx.modelDirectories`): the root owner of per-session
 * {@link ModelDirectory} instances. Both selection entries (the /model popup
 * and the composer model seat) resolve their session's directory through
 * this service, which is what makes the dual entry one shared state.
 *
 * Per-session storage follows the client service pattern (InputTriggerService /
 * CommandUiRuntime): a lazy service-internal map whose entry is deleted by the
 * owning scope's disposer. The host `dsh-scope` ScopedLayers registry does
 * does not belong here: it derives scope from the host carrier mechanism
 * (object-keyed), while client scopes tag contexts with branded SessionId
 * strings, and it models global+shadow named registries — this is a
 * per-session singleton with no global layer to merge.
 */
import type {} from "@deepseek-ai/dsh-client-product-analytics/client";
import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import type { SessionBinding } from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { WeakMapWithValues } from "@deepseek-ai/dsh-util-values";
import { ModelCatalogDirectory } from "./catalog.ts";
import { preferenceCall } from "./preferences-api.ts";
import { ModelDirectory } from "./directory.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    modelDirectories: ModelDirectoryResolver;
  }
}

/** Live mutable state in one holder (service methods run behind the caller-ctx tracker). */
interface LiveState {
  /** Directories keyed by Client binding, removed by their scope disposer. */
  readonly directories: WeakMapWithValues<SessionBinding, ModelDirectory>;
}

/** The `ctx.modelDirectories` session model-selection service. */
export class ModelDirectoryResolver extends Service {
  static inject = ["sessions", "remote", "remote.session"];

  private readonly live: LiveState = { directories: new WeakMapWithValues() };
  private readonly catalog: ModelCatalogDirectory;

  /**
   * @param ctx - owning root context (the service registers itself as `models`).
   */
  constructor(ctx: Context) {
    super(ctx, "modelDirectories");
    this.catalog = new ModelCatalogDirectory(ctx);
    void this.migrateLegacyFavorites().catch(() => {});
    ctx.remote.$on("codexhost/preferences-changed", () => this.catalog.refresh());
    ctx.remote.$on("codexhost/display-settings-changed", () => this.catalog.refresh());
    ctx.effect(() => {
      const focus = () => this.catalog.refresh();
      const visible = () => {
        if (document.visibilityState === "visible") this.catalog.refresh();
      };
      window.addEventListener("focus", focus);
      document.addEventListener("visibilitychange", visible);
      return () => {
        window.removeEventListener("focus", focus);
        document.removeEventListener("visibilitychange", visible);
        this.catalog.dispose();
      };
    }, "ui-model-selection: catalog lifecycle");
    void this.catalog.load().catch(() => {
      /* selectors expose the shared error */
    });
    ctx.on("connection/reset", () => {
      this.catalog.resetGeneration();
      for (const directory of this.live.directories.values) directory.resetConnected();
    });
    ctx.remote.$on("llm/adapters-updated", () => {
      this.catalog.refresh();
    });
    ctx.remote.$on("settings/document-updated", () => {
      this.catalog.refresh();
    });
    ctx.remote.$on("credentials/record-updated", () => {
      this.catalog.refresh();
    });
    ctx.remote.$on("credentials/reference-updated", () => {
      this.catalog.refresh();
    });
  }
  private async migrateLegacyFavorites() {
    const grouped = new Map<string, string[]>();
    try {
      const old: unknown = JSON.parse(localStorage.getItem("codexhost:model-favorites:v1") ?? "[]");
      if (Array.isArray(old))
        for (const key of old) {
          try {
            const pair: unknown = JSON.parse(String(key));
            if (
              Array.isArray(pair) &&
              pair.length === 2 &&
              pair.every((value) => typeof value === "string")
            )
              grouped.set(pair[0], [...(grouped.get(pair[0]) ?? []), pair[1]]);
          } catch {
            /* Invalid old rows are skipped. */
          }
        }
    } catch {
      /* No browser storage is also a valid starting point. */
    }
    await preferenceCall("migrate", {
      favorites: [...grouped].map(([provider, modelIds]) => ({ provider, modelIds })),
    });
    this.catalog.refresh();
  }
  async setFavorite(provider: string, modelId: string, enabled: boolean) {
    await preferenceCall("patch", {
      operation: { kind: "favorite", harnessId: provider, modelId, enabled },
    });
    this.catalog.refresh();
    await this.catalog.load();
  }

  /**
   * Resolve the per-session shared directory (lazy; the scope disposer
   * removes and disposes it). Unknown sessions fail loud.
   * @param sessionId - the owning session.
   * @returns the resident directory both entries share.
   */
  directoryFor(sessionId: SessionId): ModelDirectory {
    const { live } = this;
    const sessions = this.ctx.sessions;
    const actx = sessions.scope(sessionId);
    if (actx === undefined)
      throw new Error(`ui-model-selection: session "${String(sessionId)}" resolved no scope`);
    const binding = sessions.binding(sessionId);
    if (binding === undefined)
      throw new Error(`ui-model-selection: session "${String(sessionId)}" resolved no binding`);
    const existing = live.directories.get(binding);
    if (existing !== undefined) return existing;
    const directory = new ModelDirectory(
      this.ctx.remote.session,
      sessionId,
      () => sessions.subagentAddress(sessionId) === undefined,
      this.catalog,
      binding.session.projections.faceOf("modelSelection"),
      () => binding.session.getSnapshot().blank,
      (name, attributes) => this.ctx.get("productAnalytics")?.track(name, attributes),
    );
    live.directories.set(binding, directory);
    actx.effect(
      () => () => {
        directory.dispose();
        live.directories.delete(binding);
      },
      "ui-model-selection: session directory",
    );
    return directory;
  }
}

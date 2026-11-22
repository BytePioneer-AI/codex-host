/** A shared local Host catalog, or one explicitly scoped remote Session catalog. */

import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type {
  ModelCatalog,
  ModelSelection,
  ModelProviderGroup,
  SessionId,
} from "@deepseek-ai/dsh-api-remotes/client";
import { createSnapshotStore, type SnapshotStore } from "@deepseek-ai/dsh-client-store";

/** Observable lifecycle of the shared model catalog. */
export interface ModelCatalogState {
  value: ModelCatalog | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
}

/** Loads at most one model catalog for the current Host generation. */
export class ModelCatalogDirectory {
  /** Current shared catalog value and load lifecycle. */
  readonly store: SnapshotStore<ModelCatalogState> = createSnapshotStore({
    value: null,
    status: "idle",
    error: null,
  });

  private readonly reasoning = new Map<string, ModelProviderGroup["models"][number]["reasoning"]>();

  /**
   * Read the last advertised reasoning metadata, including unavailable models.
   * @param selection - provider and model whose effort is displayed.
   * @returns reasoning metadata observed during this Host generation.
   */
  reasoningFor(selection: ModelSelection): ModelProviderGroup["models"][number]["reasoning"] {
    return this.reasoning.get(JSON.stringify([selection.provider, selection.model]));
  }

  private disposed = false;
  private refreshRequested = false;
  private readonly hostRefreshes = new Set<string | undefined>();
  private generation = 0;
  private inflight: Promise<ModelCatalog> | undefined;

  /**
   * @param ctx - the providing plugin's context, whose `remote.session`
   * namespace carries the model catalog.
   * @param sessionId - remote Session whose Host owns this catalog; omitted for the shared local catalog.
   */
  constructor(
    private readonly ctx: ClientContext,
    private readonly sessionId?: SessionId,
  ) {}

  /**
   * Return the current generation's catalog, sharing its one in-flight load.
   * @returns the loaded catalog for this scope.
   */
  load(): Promise<ModelCatalog> {
    if (this.disposed) return Promise.reject(new Error("Model catalog disposed"));
    const state = this.store.getSnapshot();
    if (state.status === "ready" && state.value !== null) return Promise.resolve(state.value);
    if (this.inflight !== undefined) return this.inflight;
    const generation = this.generation;
    this.store.update((draft) => {
      draft.status = "loading";
      draft.error = null;
    });
    const operation = (async () => {
      let result: { value: ModelCatalog } | { error: Error };
      let refreshFailure: Error | undefined;
      do {
        this.refreshRequested = false;
        const target = this.hostRefreshes.values().next();
        if (!target.done) this.hostRefreshes.delete(target.value);
        try {
          const response = await (this.sessionId === undefined
            ? // The pinned gateway requires one argument slot; undefined is omitted on the wire.
              this.ctx.remote.session.modelCatalog(
                target.done
                  ? undefined
                  : {
                      refresh: true,
                      ...(target.value === undefined ? {} : { harnessId: target.value }),
                    },
              )
            : this.ctx.remote.session.modelCatalog({ sessionId: this.sessionId }));
          if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
          result = { value: response.value };
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          result = { error: failure };
          // Follow-up reads still reconcile the catalog, but cannot erase an explicit refresh failure.
          if (!target.done) refreshFailure ??= failure;
        }
      } while (
        generation === this.generation &&
        (this.refreshRequested || this.hostRefreshes.size > 0)
      );
      if ("error" in result) throw refreshFailure ?? result.error;
      const { value } = result;
      if (generation === this.generation) {
        for (const group of value.groups) {
          for (const model of group.models) {
            this.reasoning.set(JSON.stringify([group.id, model.id]), model.reasoning);
            if (model.fastModel !== undefined)
              this.reasoning.set(JSON.stringify([group.id, model.fastModel]), model.reasoning);
            if (model.ultrafastModel !== undefined)
              this.reasoning.set(JSON.stringify([group.id, model.ultrafastModel]), model.reasoning);
          }
        }
        this.store.set({
          value,
          status: refreshFailure ? "error" : "ready",
          error: refreshFailure?.message ?? null,
        });
      }
      if (refreshFailure) throw refreshFailure;
      return value;
    })()
      .catch((error: unknown) => {
        if (generation === this.generation) {
          this.store.update((draft) => {
            draft.status = "error";
            draft.error = error instanceof Error ? error.message : String(error);
          });
        }
        throw error;
      })
      .finally(() => {
        if (generation === this.generation && this.inflight === operation)
          this.inflight = undefined;
      });
    this.inflight = operation;
    return operation;
  }

  /**
   * Invalidate the loaded catalog; the next explicit menu read reloads it.
   * @param clear - whether values from the previous Host generation must be hidden.
   */
  private invalidate(clear = false): void {
    this.generation += 1;
    this.refreshRequested = false;
    this.hostRefreshes.clear();
    this.inflight = undefined;
    const value = clear ? null : this.store.getSnapshot().value;
    this.store.set({ value, status: "idle", error: null });
  }

  /** Invalidate and reload the catalog after a Host-side model input changes. */
  refresh(): void {
    if (this.disposed) return;
    if (this.inflight) {
      this.refreshRequested = true;
      return;
    }
    this.invalidate();
    void this.load().catch(() => {
      /* the selector exposes the shared error */
    });
  }

  /** Refresh the local Host, serialized with any already-running catalog read. */
  refreshModels(harnessId?: string): Promise<ModelCatalog> {
    if (!this.inflight) this.invalidate();
    this.hostRefreshes.add(harnessId);
    return this.load();
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.refreshRequested = false;
    this.hostRefreshes.clear();
    this.inflight = undefined;
  }

  resetGeneration(): void {
    if (this.disposed) return;
    this.reasoning.clear();
    this.invalidate(true);
    void this.load().catch(() => {
      /* the selector exposes the shared error */
    });
  }
}

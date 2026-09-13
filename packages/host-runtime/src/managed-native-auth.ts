import type { JsonObject } from "@codexhost/protocol-core";
import { jsonObjectSchema } from "@codexhost/shared-contracts";

import type { CodexAccountControl } from "./account/codex-account-control.js";
import { nativeChatgptLoginParamsSchema } from "./account/native-chatgpt-login.js";
import type { OfficialRuntimeOwner } from "./codex-runtime/official-runtime-owner.js";
import type { OfficialRuntimeScope } from "./codex-runtime/official-runtime-scope.js";
import { OfficialAdmissionError } from "./codex-runtime/official-work-gate.js";

type NativeAuthScope = Pick<OfficialRuntimeScope, "gate" | "closed"> & {
  owner: Pick<OfficialRuntimeOwner, "generation" | "running" | "controlRequest">;
};
const object = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Adapts native Desktop authentication to the existing global Account coordinator.
 * Owns protocol delivery only: no credentials, process ownership or second transaction. */
export class ManagedNativeAuth {
  readonly #control: CodexAccountControl;
  readonly #scope: NativeAuthScope;
  readonly #notify: (method: string, params: JsonObject) => Promise<void>;
  readonly #diagnose: () => void;
  readonly #unsubscribe: () => void;
  readonly #startReplies = new Set<Promise<void>>();
  #initialized = false;
  #closed = false;
  #lastGeneration = -1;
  #publishing: Promise<void> | undefined;

  constructor(input: {
    control: CodexAccountControl;
    scope: NativeAuthScope;
    notify(method: string, params: JsonObject): Promise<void>;
    diagnose(): void;
  }) {
    this.#control = input.control;
    this.#scope = input.scope;
    this.#notify = input.notify;
    this.#diagnose = input.diagnose;
    this.#unsubscribe = input.scope.gate.subscribe(() => this.#scheduleAccountUpdate());
  }

  /** Called after the Desktop initialize reply. A native initialization already
   * establishes this generation; Host-only initialization does not. */
  initialized(nativeGeneration: number | undefined): void {
    if (this.#closed) return;
    this.#initialized = true;
    this.#lastGeneration = nativeGeneration ?? -1;
    this.#scheduleAccountUpdate();
  }

  async request(
    method: string,
    params: JsonObject,
    respond: (result: JsonObject) => Promise<void>,
  ): Promise<void> {
    if (this.#closed) throw new OfficialAdmissionError("unavailable");
    if (method === "account/login/start") {
      const parsed = nativeChatgptLoginParamsSchema.parse(params);
      const barrier = Promise.withResolvers<undefined>();
      this.#startReplies.add(barrier.promise);
      try {
        if (!this.#control.startNativeLogin) throw new OfficialAdmissionError("unavailable");
        const started = await this.#control.startNativeLogin(parsed);
        if (this.#closed) return;
        await respond(jsonObjectSchema.parse(started.response));
        // The native UI registers its active login after this response. A Promise
        // retains early completion without another correlation/buffering machine.
        void started.completed
          .then(async (result) => {
            if (!this.#closed)
              await this.#notify("account/login/completed", jsonObjectSchema.parse(result));
          })
          .catch(() => {
            if (!this.#closed) this.#diagnose();
          });
      } finally {
        barrier.resolve(undefined);
        this.#startReplies.delete(barrier.promise);
      }
      return;
    }
    if (method === "account/login/cancel") {
      if (typeof params.loginId !== "string" || !params.loginId.trim())
        throw new Error("Invalid native login cancellation");
      const cancelled = await this.#control.cancelLogin(params.loginId);
      await respond({ status: cancelled ? "canceled" : "notFound" });
      return;
    }
    if (method !== "account/logout") throw new Error("Unsupported native authentication method");
    await this.#control.logout();
    await respond({});
  }

  #shouldPublish(): boolean {
    return (
      this.#initialized &&
      !this.#closed &&
      !this.#scope.closed &&
      this.#scope.gate.phase === "ready" &&
      this.#scope.owner.running &&
      this.#scope.owner.generation !== this.#lastGeneration
    );
  }

  #scheduleAccountUpdate(): void {
    if (!this.#shouldPublish() || this.#publishing) return;
    this.#publishing = this.#publishAccountUpdate()
      .catch(() => {
        // Native errors may contain secrets. A failed observer cannot undo a commit.
        if (!this.#closed) this.#diagnose();
      })
      .finally(() => {
        this.#publishing = undefined;
        // Coalesce generations, not user work; do not poll/retry a failed generation.
        if (this.#shouldPublish()) this.#scheduleAccountUpdate();
      });
  }

  async #publishAccountUpdate(): Promise<void> {
    // Never announce authentication before the corresponding start reply, and
    // never hold the global work lease while waiting on a slow Desktop writer.
    await Promise.all([...this.#startReplies]);
    if (!this.#shouldPublish()) return;
    const generation = this.#scope.owner.generation;
    this.#lastGeneration = generation;
    // Ready is published only after permanent-backend verification. Staging
    // remains changing and cannot enter this path, even with a new generation.
    // This non-refreshing control read must not hold up another Account operation;
    // native retirement and the generation check discard an obsolete result.
    const response = await this.#scope.owner.controlRequest("account/read", {
      refreshToken: false,
    });
    if (response.error || !object(response.result))
      throw new Error("Invalid native Account response");
    const account = response.result.account;
    let params: JsonObject;
    if (account === null) params = { authMode: null, planType: null };
    else {
      if (!object(account) || account.type !== "chatgpt")
        throw new Error("Invalid native Account response");
      params = {
        authMode: "chatgpt",
        planType: typeof account.planType === "string" ? account.planType : null,
      };
    }
    if (
      !this.#closed &&
      !this.#scope.closed &&
      this.#scope.gate.phase === "ready" &&
      this.#scope.owner.generation === generation
    )
      await this.#notify("account/updated", params);
  }

  close(): void {
    this.#closed = true;
    this.#unsubscribe();
  }
}

import type { JsonObject, JsonValue } from "@codexhost/protocol-core";
import { jsonObjectSchema } from "@codexhost/shared-contracts";
import type { CodexAccountControl } from "./account/codex-account-control.js";
import type { OfficialRuntimeOwner } from "./codex-runtime/official-runtime-owner.js";
import type { OfficialRuntimeScope } from "./codex-runtime/official-runtime-scope.js";

type AccountScope = Pick<OfficialRuntimeScope, "gate" | "closed"> & {
  owner: Pick<OfficialRuntimeOwner, "generation" | "running" | "controlRequest">;
};
const object = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Refresh displayed current identity after native auth or backend replacement.
 * No credential collection, login IDs or native event rewriting.
 */
export class NativeAccountObserver {
  readonly #unsubscribe: () => void;
  #initialized = false;
  #closed = false;
  #lastGeneration = -1;
  #publishing: Promise<void> | undefined;
  #collecting: Promise<void> | undefined;
  #collectRequested = false;

  constructor(
    private readonly input: {
      control: Pick<CodexAccountControl, "refresh">;
      scope: AccountScope;
      notify(method: string, params: JsonObject): Promise<void>;
      diagnose(): void;
    },
  ) {
    this.#unsubscribe = input.scope.gate.subscribe(() => this.#scheduleAccountUpdate());
  }

  initialized(nativeGeneration: number | undefined): void {
    if (this.#closed) return;
    this.#initialized = true;
    this.#lastGeneration = nativeGeneration ?? -1;
    this.#scheduleAccountUpdate();
    if (nativeGeneration !== undefined) this.observe({ method: "account/updated" });
  }

  /** Called after forwarding the native frame. Identity read failure cannot alter its outcome. */
  observe(value: JsonValue): void {
    if (
      !object(value) ||
      (value.method !== "account/updated" && value.method !== "account/login/completed") ||
      !this.input.control.refresh ||
      !this.#ready()
    )
      return;
    this.#collectRequested = true;
    if (this.#collecting) return;
    this.#collecting = (async () => {
      while (this.#collectRequested && this.#ready()) {
        this.#collectRequested = false;
        const generation = this.input.scope.owner.generation;
        const snapshot = await this.input.control.refresh?.();
        if (snapshot && this.#ready() && generation === this.input.scope.owner.generation)
          await this.input.notify("codexhost/account/changed", jsonObjectSchema.parse(snapshot));
      }
    })()
      .catch(() => {
        if (!this.#closed) this.input.diagnose();
      })
      .finally(() => {
        this.#collecting = undefined;
      });
  }

  #ready(): boolean {
    const { scope } = this.input;
    return !this.#closed && !scope.closed && scope.gate.phase === "ready" && scope.owner.running;
  }

  #shouldPublish(): boolean {
    return (
      this.#initialized &&
      this.#ready() &&
      this.input.scope.owner.generation !== this.#lastGeneration
    );
  }

  #scheduleAccountUpdate(): void {
    if (!this.#shouldPublish() || this.#publishing) return;
    this.#publishing = this.#publishAccountUpdate()
      .catch(() => {
        if (!this.#closed) this.input.diagnose();
      })
      .finally(() => {
        this.#publishing = undefined;
        if (this.#shouldPublish()) this.#scheduleAccountUpdate();
      });
  }

  async #publishAccountUpdate(): Promise<void> {
    const { scope, notify } = this.input;
    const generation = scope.owner.generation;
    this.#lastGeneration = generation;
    // Announce only a ready backend generation, without blocking work or retrying forever.
    const response = await scope.owner.controlRequest("account/read", { refreshToken: false });
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
    if (this.#ready() && scope.owner.generation === generation)
      await notify("account/updated", params);
  }

  close(): void {
    this.#closed = true;
    this.#unsubscribe();
  }
}

import type { JsonObject, JsonValue } from "@codexhost/protocol-core";
import type { OfficialWorkGate } from "../codex-runtime/official-work-gate.js";
import type { CodexCredentialIdentity } from "./native-codex-credentials.js";

/** Sole owned native process. A staging home never serves Desktop work. */
export interface NativeAccountRuntime {
  readonly gate: OfficialWorkGate;
  preflight(): Promise<void>;
  assertNativeIdle(): Promise<void>;
  stop(): Promise<void>;
  /** No argument starts the permanent home; a staging home is management-only. */
  start(stagingHome?: string): Promise<void>;
  verify(identity: CodexCredentialIdentity | null): Promise<void>;
  controlRequest(method: string, params: JsonObject): Promise<JsonObject>;
  subscribe(listener: (value: JsonValue) => void): () => void;
}

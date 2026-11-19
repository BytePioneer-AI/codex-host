import { stripVTControlCharacters } from "node:util";

import { grokPermissionModeSessionMeta, type GrokPermissionMode } from "./permission-modes.js";

export const GROK_PERMISSION_MODE_METHOD = "_x.ai/yolo_mode_changed";
const permissionManagerLog = "xai_grok_workspace::permission::manager=info";

export function grokPermissionLogFilter(existing: string | undefined): string {
  return existing ? `${existing},${permissionManagerLog}` : permissionManagerLog;
}

/**
 * Grok 1.0.67 has no permission getter or notification reply. Its dedicated
 * process's permission manager reports the applied flags, including policy clamps.
 * Subagents inherit that manager. Missing or changed log output cannot confirm a mode.
 */
export class GrokPermissionConfirmation {
  readonly #expected: { yoloMode: boolean; autoMode: boolean };
  readonly #completion = Promise.withResolvers<undefined>();
  #yolo: boolean | undefined;
  #auto: boolean | undefined;
  #buffer = "";

  constructor(mode: GrokPermissionMode) {
    this.#expected = grokPermissionModeSessionMeta(mode);
  }

  get completed(): Promise<void> {
    return this.#completion.promise;
  }

  accept(chunk: string): void {
    this.#buffer += chunk;
    let newline: number;
    while ((newline = this.#buffer.indexOf("\n")) !== -1) {
      const line = stripVTControlCharacters(this.#buffer.slice(0, newline)).trimEnd();
      this.#buffer = this.#buffer.slice(newline + 1);
      const match =
        /^\d{4}-\d{2}-\d{2}T\S+\s+INFO\s+(?:.*?: )?(always-approve|auto permission mode) set to: (true|false)$/.exec(
          line,
        );
      if (!match) continue;
      const value = match[2] === "true";
      if (match[1] === "always-approve") this.#yolo = value;
      else this.#auto = value;
      if (
        (this.#yolo !== undefined && this.#yolo !== this.#expected.yoloMode) ||
        (this.#auto !== undefined && this.#auto !== this.#expected.autoMode)
      ) {
        this.reject(new Error("Grok did not apply the requested Permission Mode"));
      } else if (this.#yolo !== undefined && this.#auto !== undefined) {
        this.#completion.resolve(undefined);
      }
    }
    // A partial diagnostic line must not retain unbounded process output.
    if (this.#buffer.length > 16_384) this.#buffer = "";
  }

  reject(error: Error): void {
    this.#completion.reject(error);
  }
}

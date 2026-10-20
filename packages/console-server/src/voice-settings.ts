import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_VOICE_ROUTES,
  voiceRoutesSchema,
  type VoiceSettings,
  type VoiceSettingsRequest,
} from "@codexhost/shared-contracts";
import { LIVE_VOICE_INJECT_FILE, writeLiveVoiceInjectFile } from "./live-voice-inject.js";

export class VoiceSettingsConflict extends Error {}

/** The single console serializes Desktop migration and edits from both surfaces. */
export class VoiceSettingsStore {
  #writes: Promise<unknown> = Promise.resolve();
  readonly #runtime = new Map<string, { revision: string; activeCall: boolean; at: number }>();
  constructor(private readonly directory: string) {}

  async read() {
    let document: { version?: unknown; inject?: unknown; routes?: unknown } | null = null;
    try {
      document = JSON.parse(
        await readFile(path.join(this.directory, LIVE_VOICE_INJECT_FILE), "utf8"),
      );
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Could not read voice settings");
    }
    const routes =
      document?.version === 1 ? voiceRoutesSchema.safeParse(document.routes).data : undefined;
    const settings: VoiceSettings = {
      ...(routes ?? DEFAULT_VOICE_ROUTES),
      inject: document?.version !== 1 || document.inject !== false,
    };
    const revision = createHash("sha256")
      .update(JSON.stringify({ settings, initialized: !!routes }))
      .digest("hex");
    const runtime = [...this.#runtime.values()].filter((entry) => Date.now() - entry.at < 12_000);
    return {
      settings,
      initialized: !!routes,
      revision,
      activeCall: runtime.length ? runtime.some((entry) => entry.activeCall) : null,
      routesActive: runtime.length ? runtime.every((entry) => entry.revision === revision) : null,
    };
  }

  report(runtime: { id: string; revision: string; activeCall: boolean }): void {
    for (const [id, entry] of this.#runtime)
      if (Date.now() - entry.at >= 12_000) this.#runtime.delete(id);
    if (this.#runtime.size < 32 || this.#runtime.has(runtime.id))
      this.#runtime.set(runtime.id, { ...runtime, at: Date.now() });
  }

  async setInjection(inject: boolean): Promise<void> {
    const operation = this.#writes.then(async () => {
      const current = await this.read();
      if (current.activeCall)
        throw new VoiceSettingsConflict("End your voice call before applying changes.");
      await writeLiveVoiceInjectFile(this.directory, inject);
    });
    this.#writes = operation.catch(() => undefined);
    await operation;
  }

  async write(input: Extract<VoiceSettingsRequest, { operation: "migrate" | "set" }>) {
    const operation = this.#writes.then(async () => {
      const current = await this.read();
      if (input.operation === "migrate" && current.initialized) return current;
      if (input.operation === "set") {
        if (current.activeCall)
          throw new VoiceSettingsConflict("End your voice call before applying changes.");
        if (input.revision !== current.revision)
          throw new VoiceSettingsConflict(
            "Voice settings changed in another window. Reload and try again.",
          );
      }
      const settings =
        input.operation === "set" ? input.settings : { ...current.settings, ...input.routes };
      await writeLiveVoiceInjectFile(this.directory, settings.inject, {
        chatExperience: settings.chatExperience,
        chatConnection: settings.chatConnection,
        workConnection: settings.workConnection,
      });
      return this.read();
    });
    this.#writes = operation.catch(() => undefined);
    return operation;
  }
}

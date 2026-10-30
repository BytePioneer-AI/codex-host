import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import {
  harnessConfigurationStateSchema,
  nativeSessionRefSchema,
  type HarnessConfigurationState,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";

const reservationSchema = z.strictObject({
  version: z.literal(1),
  sessionId: z.uuid(),
  cwd: z.string().min(1),
  configuration: harnessConfigurationStateSchema,
});

export function isPendingClaudeSession(ref: NativeSessionRef): boolean {
  return ref.locator !== undefined;
}

/** Durable empty history. The separate, exclusive claim is never inferred from a missing transcript. */
export class ClaudePendingSessions {
  readonly #directory: string;

  constructor(environment: NodeJS.ProcessEnv) {
    this.#directory = path.join(
      path.resolve(environment.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude")),
      "codexhost",
      "pending-sessions",
    );
  }

  #path(ref: NativeSessionRef, cwd: string): string {
    if (
      ref.harnessId !== "claude-code" ||
      !z.uuid().safeParse(ref.nativeSessionId).success ||
      !z.strictObject({ pendingSession: z.literal(1) }).safeParse(ref.locator).success ||
      !path.isAbsolute(cwd)
    ) {
      throw new Error("Claude Code pending Session identity is invalid");
    }
    return path.join(this.#directory, ref.nativeSessionId);
  }

  async create(cwd: string, configuration: HarnessConfigurationState): Promise<NativeSessionRef> {
    const ref = nativeSessionRefSchema.parse({
      harnessId: "claude-code",
      nativeSessionId: randomUUID(),
      locator: { pendingSession: 1 },
      formatVersion: 1,
    });
    const directory = this.#path(ref, cwd);
    const reservation = reservationSchema.parse({
      version: 1,
      sessionId: ref.nativeSessionId,
      cwd,
      configuration,
    });
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
    try {
      const file = await open(path.join(directory, "session.json"), "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(reservation));
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    await this.#sync(directory);
    await this.#sync(this.#directory);
    return ref;
  }

  async read(
    ref: NativeSessionRef,
    cwd: string,
  ): Promise<{
    started: boolean;
    configuration: HarnessConfigurationState;
  }> {
    const directory = this.#path(ref, cwd);
    const reservation = reservationSchema.parse(
      JSON.parse(await readFile(path.join(directory, "session.json"), "utf8")),
    );
    if (reservation.sessionId !== ref.nativeSessionId || reservation.cwd !== cwd) {
      throw new Error("Claude Code pending Session does not belong to this working directory");
    }
    let started = false;
    try {
      const claim = await stat(path.join(directory, "started"));
      if (!claim.isFile()) throw new Error("Claude Code pending Session claim is invalid");
      started = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { started, configuration: reservation.configuration };
  }

  async saveConfiguration(
    ref: NativeSessionRef,
    cwd: string,
    configuration: HarnessConfigurationState,
  ): Promise<void> {
    await this.read(ref, cwd);
    const directory = this.#path(ref, cwd);
    const temporary = path.join(directory, `${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(
          JSON.stringify(
            reservationSchema.parse({
              version: 1,
              sessionId: ref.nativeSessionId,
              cwd,
              configuration,
            }),
          ),
        );
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path.join(directory, "session.json"));
      await this.#sync(directory);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async #sync(directory: string): Promise<void> {
    if (process.platform === "win32") return;
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async claim(ref: NativeSessionRef, cwd: string): Promise<void> {
    await this.read(ref, cwd);
    // wx arbitrates competing wrappers/processes before either can start the native CLI.
    const claim = await open(path.join(this.#path(ref, cwd), "started"), "wx", 0o600);
    try {
      await claim.sync();
    } finally {
      await claim.close();
    }
    await this.#sync(this.#path(ref, cwd));
  }

  /** Only the claim owner may release, after proven close and before submitting any native input. */
  async release(ref: NativeSessionRef, cwd: string): Promise<void> {
    await unlink(path.join(this.#path(ref, cwd), "started"));
    await this.#sync(this.#path(ref, cwd));
  }

  async discard(ref: NativeSessionRef, cwd: string): Promise<void> {
    await rm(this.#path(ref, cwd), { recursive: true, force: true });
  }
}

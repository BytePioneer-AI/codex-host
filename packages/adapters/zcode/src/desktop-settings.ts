import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseDesktopPairing, type DesktopPairing } from "./desktop-relay.js";
import { ZcodeError } from "./errors.js";
import { z } from "zod";

export type DesktopConfiguration = DesktopPairing & { cwd: string };
const configurationSchema = z
  .object({ url: z.string().max(8192), cwd: z.string().min(1).max(16_384) })
  .strict();

/** Only user-entered pairing material. Never reads ZCode's account/configuration stores. */
export class DesktopSettings {
  readonly directory: string;
  constructor(environment: NodeJS.ProcessEnv) {
    this.directory = path.join(
      environment.CODEXHOST_DATA_DIR
        ? path.resolve(environment.CODEXHOST_DATA_DIR)
        : path.join(homedir(), ".codexhost"),
      "harness-connections",
      "zcode",
    );
  }
  async read(): Promise<DesktopConfiguration | undefined> {
    try {
      const value = configurationSchema.parse(
        JSON.parse(await readFile(path.join(this.directory, "pairing"), "utf8")),
      );
      if (!path.isAbsolute(value.cwd)) throw new Error();
      return { ...parseDesktopPairing(value.url), cwd: value.cwd };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return undefined;
      throw new ZcodeError(
        "authenticationRequired",
        "ZCode Desktop connection settings are invalid; pair again in Connections",
      );
    }
  }
  async set(secret: string | null, cwd?: string) {
    const file = path.join(this.directory, "pairing");
    if (secret === null) {
      await rm(file, { force: true });
      return;
    }
    parseDesktopPairing(secret);
    if (!cwd || !path.isAbsolute(cwd) || !(await stat(cwd)).isDirectory())
      throw new ZcodeError(
        "invalidRequest",
        "Specify an existing absolute workspace directory that is open in ZCode",
      );
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ url: secret.trim(), cwd: path.resolve(cwd) }), {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  /** Each contender publishes a unique register BEFORE checking other owners. Simultaneous
   * contenders may both fail (explicit retry), but cannot both enter. No shared lock pathname
   * is ever unlinked; crashed owners are ignored by PID, never by an expiring live lease. */
  async acquire(deviceSid: string): Promise<() => Promise<void>> {
    const directory = path.join(
      this.directory,
      "owners",
      createHash("sha256").update(deviceSid).digest("hex"),
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const name = `${process.pid}-${randomUUID()}`,
      file = path.join(directory, name);
    await writeFile(file, "", { flag: "wx", mode: 0o600 });
    const release = () => rm(file, { force: true });
    try {
      for (const other of await readdir(directory)) {
        if (other === name) continue;
        const pid = Number(other.split("-")[0]);
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error();
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch (error) {
          alive = !(
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ESRCH"
          );
        }
        if (alive) throw new Error();
      }
      return release;
    } catch {
      await release();
      throw new ZcodeError(
        "sessionBusy",
        "Another codexhost connection owns this ZCode Desktop pairing. Close it before connecting here.",
        true,
      );
    }
  }
}

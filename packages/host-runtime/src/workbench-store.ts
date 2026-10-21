import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { workbenchConfigSchema, type WorkbenchConfig } from "@codexhost/shared-contracts";

export class WorkbenchStore {
  readonly #file: string;

  constructor(environment: NodeJS.ProcessEnv) {
    const directory = environment.CODEXHOST_DATA_DIR
      ? path.resolve(environment.CODEXHOST_DATA_DIR)
      : path.join(os.homedir(), ".codexhost");
    this.#file = path.join(directory, "workbench.json");
  }

  async get(): Promise<WorkbenchConfig> {
    try {
      return workbenchConfigSchema.parse(JSON.parse(await readFile(this.#file, "utf8")));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return { version: 1, entries: [] };
      // 损坏的配置不能降级为空，避免用户保存时覆盖原有入口。
      throw new Error("Workbench configuration could not be read");
    }
  }

  async set(input: unknown): Promise<WorkbenchConfig> {
    const config = workbenchConfigSchema.parse(input);
    await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, this.#file);
    } finally {
      await rm(temporary, { force: true });
    }
    return config;
  }
}

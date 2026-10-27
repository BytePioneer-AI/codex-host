import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { loadHostIdentity } from "../src/host-identity.js";

it("publishes one stable identity across simultaneous starts and preserves a corrupt file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "codexhost-identity-"));
  try {
    const environment = { CODEXHOST_DATA_DIR: directory };
    const ids = await Promise.all(Array.from({ length: 12 }, () => loadHostIdentity(environment)));
    expect(new Set(ids).size).toBe(1);
    expect(await loadHostIdentity(environment)).toBe(ids[0]);
    await writeFile(path.join(directory, "host-id"), "corrupt");
    await expect(loadHostIdentity(environment)).rejects.toThrow();
    expect(await readFile(path.join(directory, "host-id"), "utf8")).toBe("corrupt");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

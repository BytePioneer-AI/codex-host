import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { canonicalSessionPath } from "@codexhost/session-runtime";
import { readSharedHostExitProof } from "../src/shared-host-exit-proof.js";

it("accepts only a private native proof for the canonical Host profile and translates its owner root in Node", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "host-exit-proof-"));
  try {
    const file = path.join(root, "shared-host-exit-v1.json");
    const proof = {
      version: 1,
      pid: 123456,
      generation: "123-456",
      dataRoot: canonicalSessionPath(root),
    };
    await writeFile(file, JSON.stringify(proof), { mode: 0o600 });
    const environment = { CODEXHOST_DATA_DIR: root, CODEXHOST_SHARED_HOST_GENERATION: "789-123" };
    expect(await readSharedHostExitProof(environment)).toEqual({
      pid: proof.pid,
      generation: proof.generation,
      ownerRoot: canonicalSessionPath(path.join(root, "web-codex")),
    });
    expect(await readSharedHostExitProof({ CODEXHOST_DATA_DIR: root })).toBeUndefined();
    await mkdir(path.join(root, "other"));
    await writeFile(
      file,
      JSON.stringify({ ...proof, dataRoot: canonicalSessionPath(path.join(root, "other")) }),
    );
    await expect(readSharedHostExitProof(environment)).rejects.toThrow("native-exit-proof-invalid");
    await writeFile(file, JSON.stringify({ ...proof, version: 2 }));
    await expect(readSharedHostExitProof(environment)).rejects.toThrow("native-exit-proof-invalid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

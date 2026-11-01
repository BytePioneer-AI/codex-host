import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { harnessThinkingOptionIdSchema } from "@codexhost/shared-contracts";
import { persistEmptyPiSession, readPiEmptySessionConfiguration } from "../src/pi-empty-session.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), "codexhost-pi-empty-"));
  roots.push(cwd);
  const sourceSessionFile = path.join(cwd, "source.jsonl");
  const sessionFile = path.join(cwd, "empty.jsonl");
  const source = JSON.stringify({ type: "session", version: 3, id: "source", cwd }) + "\n";
  await writeFile(sourceSessionFile, source);
  return {
    cwd,
    source,
    sourceSessionFile,
    sourceSessionId: "source",
    state: {
      sessionId: "empty",
      sessionFile,
      provider: "provider",
      modelId: "model",
      thinkingLevel: harnessThinkingOptionIdSchema.parse("high"),
      contextUsage: null,
    },
    history: {
      leafId: "thinking",
      entries: [
        {
          type: "model_change",
          id: "model",
          parentId: null,
          provider: "provider",
          modelId: "model",
        },
        { type: "thinking_level_change", id: "thinking", parentId: "model", thinkingLevel: "high" },
      ],
    },
  };
}
describe("Pi empty native Session persistence", () => {
  it("publishes independently recoverable v3 history without changing the source", async () => {
    const input = await fixture();
    await persistEmptyPiSession(input);
    expect(await readFile(input.sourceSessionFile, "utf8")).toBe(input.source);
    await expect(readPiEmptySessionConfiguration(input.state.sessionFile)).resolves.toEqual({
      model: { provider: "provider", id: "model" },
      thinkingLevel: "high",
    });
    expect(await readdir(input.cwd)).toEqual(["empty.jsonl", "source.jsonl"]);
  });
  it("does not overwrite an existing native destination", async () => {
    const input = await fixture();
    await writeFile(input.state.sessionFile, "another owner");
    await expect(persistEmptyPiSession(input)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(input.state.sessionFile, "utf8")).toBe("another owner");
    expect(await readdir(input.cwd)).toEqual(["empty.jsonl", "source.jsonl"]);
  });
  it("rejects source identity reuse, nonempty history and unknown formats", async () => {
    const input = await fixture();
    await expect(
      persistEmptyPiSession({ ...input, state: { ...input.state, sessionId: "source" } }),
    ).rejects.toThrow("independent");
    await expect(
      persistEmptyPiSession({
        ...input,
        history: {
          leafId: "user",
          entries: [
            {
              id: "user",
              parentId: null,
              type: "message",
              message: { role: "user", content: "keep me" },
            },
          ],
        },
      }),
    ).rejects.toThrow("independent");
    await writeFile(input.sourceSessionFile, input.source.replace('"version":3', '"version":4'));
    await expect(persistEmptyPiSession(input)).rejects.toThrow("native v3");
  });
  it("leaves missing, nonempty and branched native restore behavior alone", async () => {
    const input = await fixture();
    await expect(readPiEmptySessionConfiguration(input.state.sessionFile)).resolves.toBeUndefined();
    await persistEmptyPiSession(input);
    const empty = await readFile(input.state.sessionFile, "utf8");
    await writeFile(
      input.state.sessionFile,
      empty +
        JSON.stringify({
          type: "message",
          id: "user",
          parentId: "thinking",
          message: { role: "user", content: "hello" },
        }) +
        "\n",
    );
    await expect(readPiEmptySessionConfiguration(input.state.sessionFile)).resolves.toBeUndefined();
    await writeFile(
      input.state.sessionFile,
      empty.replace('"parentId":"model"', '"parentId":null'),
    );
    await expect(readPiEmptySessionConfiguration(input.state.sessionFile)).resolves.toBeUndefined();
  });
});

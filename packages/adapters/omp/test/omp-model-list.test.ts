import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { harnessModelRefSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  createOmpModelIndex,
  normalizeOmpModelCatalog,
  normalizeStoredOmpModelRef,
  resolveOmpModelRef,
} from "../src/omp-model-catalog.js";
import { listOmpModels, parseOmpModelList } from "../src/omp-model-list.js";

describe("parseOmpModelList", () => {
  it("reads provider, id and reasoning from `omp models --json`", () => {
    expect(
      parseOmpModelList(
        JSON.stringify({
          models: [
            { provider: "openai-codex", id: "gpt-5.6-luna", reasoning: true, thinking: ["low"] },
            { provider: "local", id: "tiny", reasoning: false },
          ],
        }),
      ),
    ).toEqual([
      { provider: "openai-codex", id: "gpt-5.6-luna", reasoning: true },
      { provider: "local", id: "tiny", reasoning: false },
    ]);
    expect(parseOmpModelList('{"models":[]}')).toEqual([]);
  });

  it.each([false, true])(
    "round-trips exact pairs through the catalog (collision: %s)",
    (collision) => {
      const native = { provider: "本地/提供方", id: "系列/模型 A:高~fast" };
      const other = { provider: "本地", id: "提供方/系列/模型 A:高~fast" };
      const models = [native, native, ...(collision ? [other] : [])].map((model) => ({
        ...model,
        reasoning: true,
      }));
      const catalog = normalizeOmpModelCatalog(models, native, null, null);
      const readable = harnessModelRefSchema.parse({ id: "本地/提供方/系列/模型 A:高~fast" });
      const legacy = ({ provider, id }: typeof native) =>
        harnessModelRefSchema.parse({
          id: `omp-model-v1.${Buffer.from(JSON.stringify([provider, id])).toString("base64url")}`,
        });
      const base = collision ? legacy(native) : readable;
      expect(catalog.defaultModel).toEqual(base);
      expect(catalog.models).toHaveLength(collision ? 2 : 1);
      const index = createOmpModelIndex(models);
      expect(resolveOmpModelRef(base, index)).toEqual(native);
      expect(normalizeStoredOmpModelRef(legacy(native), catalog)).toEqual(base);
      if (collision) {
        expect(resolveOmpModelRef(legacy(other), index)).toEqual(other);
        expect(() => resolveOmpModelRef(readable, index)).toThrow();
      } else {
        expect(normalizeStoredOmpModelRef(legacy(other), catalog)).toBeUndefined();
      }
    },
  );

  it.each(["not json", "{}", '{"models":[{"provider":"p","id":"m"}]}', '{"models":[{"id":"m"}]}'])(
    "rejects output %j",
    (output) => {
      expect(parseOmpModelList(output)).toBeNull();
    },
  );
});

describe.skipIf(process.platform === "win32")("listOmpModels", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  async function fakeOmp(script: string): Promise<string> {
    directory = await mkdtemp(path.join(tmpdir(), "omp-model-list-"));
    const executable = path.join(directory, "omp");
    await writeFile(executable, `#!/bin/sh\n${script}\n`);
    await chmod(executable, 0o755);
    return executable;
  }

  it("runs `models --json` in the inspected cwd", async () => {
    const command = await fakeOmp(
      `[ "$1 $2" = "models --json" ] || exit 2
printf '{"models":[{"provider":"p","id":"%s","reasoning":false}]}' "$(basename "$PWD")"`,
    );
    const cwd = path.dirname(command);
    await expect(listOmpModels({ cwd, command })).resolves.toEqual({
      kind: "models",
      models: [{ provider: "p", id: path.basename(cwd), reasoning: false }],
    });
  });

  it("leaves an OMP that cannot list Models to Session inspection", async () => {
    const command = await fakeOmp("echo 'unknown command' >&2; exit 1");
    await expect(listOmpModels({ cwd: path.dirname(command), command })).resolves.toEqual({
      kind: "unanswered",
    });
  });

  it("stops the whole process tree on timeout", async () => {
    const command = await fakeOmp(`sleep 30 &
echo $! > "$PWD/descendant.pid"
wait`);
    const cwd = path.dirname(command);
    await expect(listOmpModels({ cwd, command, timeoutMs: 2_000 })).resolves.toEqual({
      kind: "timedOut",
    });
    const descendant = Number((await readFile(path.join(cwd, "descendant.pid"), "utf8")).trim());
    await expect.poll(() => isRunning(descendant)).toBe(false);
  });

  it("stops on abort and reports unanswered", async () => {
    const command = await fakeOmp("sleep 30");
    const controller = new AbortController();
    const pending = listOmpModels({
      cwd: path.dirname(command),
      command,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).resolves.toEqual({ kind: "unanswered" });
  });

  it("reports a missing executable as not installed", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "omp-model-list-"));
    await expect(
      listOmpModels({ cwd: directory, command: path.join(directory, "missing-omp") }),
    ).resolves.toMatchObject({ kind: "notInstalled" });
  });
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { remapForkedSessionReferences } from "../src/claude-fork-references.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const cwd = "/work/project";

async function writeTranscript(entries: unknown[]) {
  const configDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhost-claude-"));
  directories.push(configDirectory);
  const transcriptDirectory = path.join(
    configDirectory,
    "projects",
    cwd.replace(/[^A-Za-z0-9]/gu, "-"),
  );
  await mkdir(transcriptDirectory, { recursive: true });
  const file = path.join(transcriptDirectory, "derived.jsonl");
  const contents = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  await writeFile(file, contents, "utf8");
  return {
    contents,
    file,
    transcriptDirectory,
    input: { cwd, environment: { CLAUDE_CONFIG_DIR: configDirectory }, sessionId: "derived" },
  };
}

function copied(entry: Record<string, unknown>, sourceUuid: string) {
  return { ...entry, forkedFrom: { sessionId: "source", messageUuid: sourceUuid } };
}

function toolDelta(uuid: string, surfacedDefinitions: unknown[]) {
  return {
    type: "attachment",
    uuid,
    attachment: { type: "deferred_tools_delta", surfacedDefinitions },
  };
}

describe("Claude Fork reference remapping", () => {
  it("points attachment sameAs references at the copied entries", async () => {
    const definition = copied(
      toolDelta("new-definition", [{ name: "docs_read", listing: "Read a doc" }]),
      "old-definition",
    );
    // A user may paste a source UUID; message content is never a reference.
    const user = copied(
      {
        type: "user",
        uuid: "new-user",
        message: { role: "user", content: [{ type: "text", text: "old-definition" }] },
        sameAs: "old-definition",
      },
      "old-user",
    );
    const resurfaced = copied(
      toolDelta("new-resurfaced", [
        { name: "docs_read", sameAs: "old-definition" },
        { name: "unknown", sameAs: "not-copied" },
      ]),
      "old-resurfaced",
    );
    const { file, input } = await writeTranscript([definition, user, resurfaced]);

    await expect(remapForkedSessionReferences(input)).resolves.toBe(1);

    const lines = (await readFile(file, "utf8")).split("\n");
    expect(lines).toEqual([
      JSON.stringify(definition),
      JSON.stringify(user),
      JSON.stringify(
        copied(
          toolDelta("new-resurfaced", [
            { name: "docs_read", sameAs: "new-definition" },
            { name: "unknown", sameAs: "not-copied" },
          ]),
          "old-resurfaced",
        ),
      ),
      "",
    ]);
  });

  it("leaves a transcript without unresolved references untouched", async () => {
    // Already-remapped references (e.g. a fixed SDK) are not source UUIDs.
    const { contents, file, input, transcriptDirectory } = await writeTranscript([
      copied(toolDelta("new-definition", [{ name: "docs_read" }]), "old-definition"),
      copied(
        toolDelta("new-resurfaced", [{ name: "docs_read", sameAs: "new-definition" }]),
        "old-resurfaced",
      ),
    ]);

    await expect(remapForkedSessionReferences(input)).resolves.toBe(0);

    await expect(readFile(file, "utf8")).resolves.toBe(contents);
    await expect(readdir(transcriptDirectory)).resolves.toEqual(["derived.jsonl"]);
  });

  it("does nothing when the derived transcript is absent", async () => {
    const { input } = await writeTranscript([]);

    await expect(remapForkedSessionReferences({ ...input, sessionId: "missing" })).resolves.toBe(0);
  });
});

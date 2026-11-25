import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  harnessIdSchema,
  hostThreadIdSchema,
  nativeSessionRefSchema,
  threadHandoffMetadataSchema,
  type NativeSessionRef,
  type ThreadHandoffMetadata,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { MappingStore } from "../src/index.js";

const temporaryDirectories: string[] = [];
const piHarness = harnessIdSchema.parse("pi");
const codexHarness = harnessIdSchema.parse("codex");

async function openStore(directory: string, instanceId: string): Promise<MappingStore> {
  const store = new MappingStore({ directory, instanceId });
  await store.initialize();
  return store;
}

async function createExternalThread(store: MappingStore, value: string) {
  const hostThreadId = hostThreadIdSchema.parse(value);
  await store.createProvisional({
    hostThreadId,
    createRequestId: `create-${value}`,
    harnessId: piHarness,
    cwd: "/synthetic",
    transportModelId: "codexhost/pi-native",
    ephemeral: false,
    historyMode: "paginated",
  });
  await store.commitReady({
    hostThreadId,
    nativeSessionRef: nativeSessionRefSchema.parse({
      harnessId: piHarness,
      nativeSessionId: `native-${value}`,
      locator: { sessionFile: `/synthetic/${value}.jsonl` },
      formatVersion: 1,
    }) as NativeSessionRef,
  });
  return hostThreadId;
}

function sampleHandoff(overrides: Partial<ThreadHandoffMetadata> = {}): ThreadHandoffMetadata {
  return threadHandoffMetadataSchema.parse({
    sourceThreadId: hostThreadIdSchema.parse("source-thread"),
    sourceHarnessId: codexHarness,
    sourceHarnessLabel: "Codex",
    sourceModel: "gpt-5.4",
    targetHarnessId: piHarness,
    targetHarnessLabel: "Pi",
    targetModel: "claude-sonnet-4-5",
    totalTurns: 5,
    boundaryTurnNumber: 4,
    includedTurnNumbers: [1, 3, 4],
    omittedTurns: 1,
    preview: "<handoff_context>\nsummary\n</handoff_context>",
    createdAtMs: 1_700_000_000_000,
    ...overrides,
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Mapping Store thread handoffs", () => {
  it("persists handoff metadata for both official Codex and external targets across restarts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-handoffs-"));
    temporaryDirectories.push(directory);
    const first = await openStore(directory, "first");
    const externalTarget = await createExternalThread(first, "external-target");
    const officialTarget = hostThreadIdSchema.parse("official-codex-target");
    const before = await first.getThread(externalTarget);

    const externalHandoff = sampleHandoff();
    const officialHandoff = sampleHandoff({
      sourceHarnessId: piHarness,
      sourceHarnessLabel: "Pi",
      targetHarnessId: codexHarness,
      targetHarnessLabel: "Codex",
    });

    await first.saveThreadHandoff(externalTarget, externalHandoff);
    await first.saveThreadHandoff(officialTarget, officialHandoff);
    // Sidecar metadata must not mutate the external Thread record revision or recency.
    await expect(first.getThread(externalTarget)).resolves.toEqual(before);
    await first.close();

    const rawThread = JSON.parse(
      await readFile(path.join(directory, "threads", `${externalTarget}.json`), "utf8"),
    );
    expect(rawThread).not.toHaveProperty("handoff");

    const second = await openStore(directory, "second");
    await expect(second.getThreadHandoff(externalTarget)).resolves.toEqual(externalHandoff);
    await expect(second.getThreadHandoff(officialTarget)).resolves.toEqual(officialHandoff);
    await expect(
      second.getThreadHandoff(hostThreadIdSchema.parse("unknown-thread")),
    ).resolves.toBeNull();
    await second.close();
  });

  it("removes handoff metadata when an external Thread is deleted or removed explicitly", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-handoffs-"));
    temporaryDirectories.push(directory);
    const first = await openStore(directory, "first");
    const externalTarget = await createExternalThread(first, "external-target");
    const officialTarget = hostThreadIdSchema.parse("official-target");
    await first.saveThreadHandoff(externalTarget, sampleHandoff());
    await first.saveThreadHandoff(officialTarget, sampleHandoff({ targetHarnessId: codexHarness }));

    await first.removeThread(externalTarget);
    await expect(first.getThreadHandoff(externalTarget)).resolves.toBeNull();
    await expect(first.getThreadHandoff(officialTarget)).resolves.not.toBeNull();

    await first.removeThreadHandoff(officialTarget);
    await expect(first.getThreadHandoff(officialTarget)).resolves.toBeNull();
    await first.close();

    const second = await openStore(directory, "second");
    await expect(second.getThreadHandoff(externalTarget)).resolves.toBeNull();
    await expect(second.getThreadHandoff(officialTarget)).resolves.toBeNull();
    await second.close();
  });

  it("quarantines a corrupt handoffs file without blocking Thread access", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-handoffs-"));
    temporaryDirectories.push(directory);
    const first = await openStore(directory, "first");
    const externalTarget = await createExternalThread(first, "external-target");
    await first.close();

    await writeFile(path.join(directory, "handoffs", "handoffs.json"), "{corrupt json");

    const second = await openStore(directory, "second");
    await expect(second.getThread(externalTarget)).resolves.toMatchObject({
      hostThreadId: externalTarget,
    });
    await expect(second.getThreadHandoff(externalTarget)).resolves.toBeNull();
    expect(
      (await readdir(path.join(directory, "quarantine"))).some((name) =>
        name.startsWith("thread-handoffs.json."),
      ),
    ).toBe(true);
    await second.close();
  });

  it("retains creating Threads with pendingInjectedText across restart while still cleaning abandoned creating records", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-handoffs-"));
    temporaryDirectories.push(directory);
    const first = await openStore(directory, "first");

    const handoffTargetId = hostThreadIdSchema.parse("deferred-handoff-target");
    await first.createProvisional({
      hostThreadId: handoffTargetId,
      createRequestId: "create-deferred-handoff",
      harnessId: piHarness,
      cwd: "/synthetic",
      transportModelId: "codexhost/pi-native",
      ephemeral: false,
      historyMode: "paginated",
    });
    await first.appendPendingInjectedText(handoffTargetId, [
      "<handoff_context>\ncontext\n</handoff_context>",
    ]);
    await first.saveThreadHandoff(handoffTargetId, sampleHandoff());

    const abandonedId = hostThreadIdSchema.parse("abandoned-creating-draft");
    await first.createProvisional({
      hostThreadId: abandonedId,
      createRequestId: "create-abandoned",
      harnessId: piHarness,
      cwd: "/synthetic",
      transportModelId: "codexhost/pi-native",
      ephemeral: false,
      historyMode: "paginated",
    });
    await first.close();

    const second = await openStore(directory, "second");
    const survived = await second.getThread(handoffTargetId);
    expect(survived).toMatchObject({
      hostThreadId: handoffTargetId,
      state: "creating",
      pendingInjectedText: ["<handoff_context>\ncontext\n</handoff_context>"],
    });
    await expect(second.getThreadHandoff(handoffTargetId)).resolves.toEqual(sampleHandoff());
    await expect(second.getThread(abandonedId)).resolves.toBeNull();
    await second.close();
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CopilotSession } from "@github/copilot-sdk";
import type { HarnessOutput } from "@codexhost/harness-adapter";
import { CopilotAdapter } from "../src/adapter.js";
import { modelRef } from "../src/configuration.js";
import type { createCopilotClient as NativeClientFactory } from "../src/client.js";

let native: CopilotSession | undefined;
vi.mock("../src/client.js", async (importOriginal) => {
  const original = await importOriginal<{ createCopilotClient: typeof NativeClientFactory }>();
  return {
    ...original,
    createCopilotClient: (input: Parameters<typeof original.createCopilotClient>[0]) => {
      const client = original.createCopilotClient(input);
      const create = client.createSession.bind(client);
      client.createSession = async (config) => {
        native = await create(config);
        return native;
      };
      return client;
    },
  };
});

describe.runIf(process.env.CODEXHOST_COPILOT_NATIVE_TEST === "1")(
  "Copilot native autonomous input",
  () => {
    it("observes native SDK input without a Host turn.start and retains its historical identity", async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), "copilot-autonomous-native-"));
      const adapter = new CopilotAdapter({ ...process.env });
      try {
        const opened = await adapter.open({ kind: "create", cwd });
        if (!opened.ok) throw new Error(opened.error.message);
        const session = opened.value;
        const outputs: HarnessOutput[] = [];
        const reading = (async () => {
          for await (const output of session.outputs) outputs.push(output);
        })();
        expect((await session.execute({ type: "model.select", model: modelRef("auto") })).ok).toBe(
          true,
        );
        if (!native) throw new Error("Missing native SDK Session");
        await native.sendAndWait(
          { prompt: "Reply exactly NATIVE_AUTONOMOUS. Do not use tools." },
          60_000,
        );
        await vi.waitFor(() =>
          expect(outputs.some((o) => o.kind === "event" && o.event.type === "turn.completed")).toBe(
            true,
          ),
        );
        const starts = outputs.flatMap((o) =>
          o.kind === "event" && o.event.type === "turn.autonomous.started" ? [o.event] : [],
        );
        const terminals = outputs.flatMap((o) =>
          o.kind === "event" && o.event.type === "turn.completed" ? [o.event] : [],
        );
        expect(starts).toHaveLength(1);
        expect(terminals).toHaveLength(1);
        expect(terminals[0]?.turnId).toBe(starts[0]?.turnId);
        expect(terminals[0]?.outcome.status).toBe("succeeded");
        const snapshot = await session.readSnapshot();
        if (!snapshot.ok) throw new Error(snapshot.error.message);
        expect(snapshot.value.turns[0]?.nativeTurnRef).toEqual(terminals[0]?.nativeTurnRef);
        expect(outputs.some((o) => o.kind === "event" && o.event.type === "turn.started")).toBe(
          false,
        );
        await session.close();
        await reading;
      } finally {
        await adapter.close();
        await rm(cwd, { recursive: true, force: true });
      }
    }, 90_000);
  },
);

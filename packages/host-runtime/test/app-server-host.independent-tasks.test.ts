import { describe, expect, it } from "vitest";

import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import { createFixture, readJsonLine, stopFixture } from "./app-server-host-fixture.js";

describe("Independent delegation tasks", () => {
  it("creates native tasks with no parent while zero, one, or several Turns are active", async () => {
    const registry = new DelegationControlRegistry();
    const fixture = createFixture({ onDelegationApi: (api) => registry.register(api) });
    try {
      await fixture.ready;
      for (let index = 0; index < 3; index++) {
        const input = {
          harnessId: "codex" as const,
          task: "independent task",
          cwd: "/synthetic",
          ...(index === 0 ? { requestId: "root-request" } : {}),
        };
        const pending = registry.start(input);
        const start = await readJsonLine(fixture.official.stdin);
        expect(start).toMatchObject({ method: "thread/start", params: { cwd: "/synthetic" } });
        fixture.official.stdout.write(
          `${JSON.stringify({ id: start.id, result: { thread: { id: `root-${index}` } } })}\n`,
        );
        const name = await readJsonLine(fixture.official.stdin);
        expect(name).toMatchObject({
          method: "thread/name/set",
          params: { name: "independent task" },
        });
        fixture.official.stdout.write(`${JSON.stringify({ id: name.id, result: {} })}\n`);
        const turn = await readJsonLine(fixture.official.stdin);
        expect(turn).toMatchObject({
          method: "turn/start",
          params: { input: [{ text: "independent task" }] },
        });
        fixture.official.stdout.write(
          `${JSON.stringify({ id: turn.id, result: { turn: { id: `turn-${index}` } } })}\n`,
        );
        const result = await pending;
        expect(result).toMatchObject({ threadId: `root-${index}` });
        expect(result).not.toHaveProperty("parentThreadId");
        if (index === 0) expect(await registry.start(input)).toMatchObject({ threadId: "root-0" });
      }
      const records = await fixture.mappingStore.listDelegations();
      expect(records).toHaveLength(3);
      for (const record of records) {
        expect(record).not.toHaveProperty("parentHostThreadId");
        expect(record).not.toHaveProperty("sourceHarnessId");
      }
    } finally {
      registry.close();
      await stopFixture(fixture);
    }
  });
});

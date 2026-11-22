import { expect, it } from "vitest";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { encodeHarnessPluginRoute, harnessIdSchema } from "@codexhost/shared-contracts";
import {
  createFixture,
  stopFixture,
  writeRequest,
  requestId,
  JsonLineCollector,
} from "./app-server-host-fixture.js";

it("routes an extension-wrapped external create to its Harness, never stock Codex", async () => {
  const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("deepseek-harness"));
  const fixture = createFixture({ externalAdapters: new Map([["deepseek-harness", adapter]]) });
  const official = new JsonLineCollector(fixture.official.stdin);
  fixture.official.stdin.on("data", () => {
    for (const r of official.messages.splice(0))
      fixture.official.stdout.write(
        JSON.stringify({
          id: r.id,
          result: { thread: { id: "wrong-native", modelProvider: "openai" } },
        }) + "\n",
      );
  });
  try {
    writeRequest(fixture.desktopInput, {
      id: 1,
      method: "thread/start",
      params: {
        request: {
          cwd: process.cwd(),
          model: encodeHarnessPluginRoute({ harnessId: harnessIdSchema.parse("deepseek-harness") }),
        },
        daybreakProgramPropagationEnrolled: false,
      },
    });
    const reply = await fixture.collector.waitFor((m) => requestId(m, 1));
    expect(reply).toMatchObject({ result: { thread: { modelProvider: "codexhost" } } });
    expect(adapter.sessions).toHaveLength(1);
  } finally {
    await stopFixture(fixture);
  }
});

it("preserves native extension parameters verbatim", async () => {
  const fixture = createFixture();
  const official = new JsonLineCollector(fixture.official.stdin);
  const params = {
    request: { cwd: process.cwd(), model: "gpt-native" },
    daybreakProgramPropagationEnrolled: true,
  };
  try {
    writeRequest(fixture.desktopInput, { id: 7, method: "thread/start", params });
    expect(await official.waitFor((m) => m.method === "thread/start")).toMatchObject({ params });
  } finally {
    await stopFixture(fixture);
  }
});

it("rejects malformed wrapped Harness routes without forwarding to native Codex", async () => {
  const fixture = createFixture();
  const official = new JsonLineCollector(fixture.official.stdin);
  try {
    writeRequest(fixture.desktopInput, {
      id: 8,
      method: "thread/start",
      params: { request: { cwd: process.cwd(), model: "codexhost/plugin-v1@bad" } },
    });
    expect(await fixture.collector.waitFor((m) => requestId(m, 8))).toHaveProperty("error");
    expect(official.messages.filter((m) => m.method === "thread/start")).toEqual([]);
  } finally {
    await stopFixture(fixture);
  }
});

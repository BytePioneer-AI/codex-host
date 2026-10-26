/** Source-mode checks through the frontend package's public src export, using Node/tsx. */
import assert from "node:assert/strict";
import { it } from "node:test";
const framework = "@deepseek-ai/cordis";
const { Context } = await import(framework);

const publicSource = "@deepseek-ai/dsh-client-ui-input-trigger/src";
const { detectTrigger } = await import(`${publicSource}/core/detect.ts`);
const { sourceMatchesTrigger } = await import(`${publicSource}/core/source.ts`);
const { InputTriggerController } = await import(`${publicSource}/client/controller.ts`);
const { InputTriggerService } = await import(`${publicSource}/client/service.ts`);

it("matches GUI word-start hash queries and preserves the exact caret span", () => {
  for (const [text, query, start] of [
    ["#", "", 0],
    ["#native", "native", 0],
    ["before #fake", "fake", 7],
    ["line\n#skill", "skill", 5],
    ["#/compact", "/compact", 0],
    ["#" + "a".repeat(32), "a".repeat(32), 0],
  ] as const) {
    assert.deepEqual(detectTrigger(text, text.length, { tier: "plain" }), {
      trigger: "#",
      query,
      quoted: false,
      position: start === 0 ? "leading" : "inline",
      span: { start, end: text.length, draftRev: 0 },
    });
  }
  assert.equal(detectTrigger("#native trailing", 7, { tier: "plain" })?.span.end, 7);
});

it("leaves numbering, Markdown, escaped text, words and URL fragments alone", () => {
  for (const text of [
    "#123",
    "#1skill",
    "##",
    "###native",
    "# ",
    "# heading",
    "before#native",
    "(#native",
    "\\#native",
    "https://host/#native",
    "https://host/#/compact",
    "path/#native",
    "##/native",
    "#" + "a".repeat(33),
  ])
    assert.equal(detectTrigger(text, text.length, { tier: "plain" }), null, text);
  for (const tier of ["claimed", "frozen"])
    assert.equal(detectTrigger("#native", 7, { tier }), null);
  assert.equal(detectTrigger("/native", 7, { tier: "plain" })?.trigger, "/");
  assert.equal(detectTrigger("/native#suffix", 14, { tier: "plain" })?.trigger, "/");
  assert.equal(detectTrigger("@file", 5, { tier: "plain" })?.trigger, "@");
});

it("registers one aliased source and rejects overlapping duplicates, then releases both triggers", () => {
  const ctx = new Context();
  ctx.provide("sessions", {});
  const service = new InputTriggerService(ctx);
  const source = {
    trigger: "/",
    aliases: ["#"],
    name: "native",
    candidates: async () => [],
    onPick: () => undefined,
  };
  assert.equal(sourceMatchesTrigger(source, "/"), true);
  assert.equal(sourceMatchesTrigger(source, "#"), true);
  assert.equal(sourceMatchesTrigger(source, "@"), false);
  const off = service.registerSource(source);
  assert.throws(
    () => service.registerSource({ ...source, trigger: "#", aliases: [] }),
    /already registered/,
  );
  off();
  service.registerSource({ ...source, trigger: "#", aliases: [] })();
});

it("shares one candidate/codec/subscription lifecycle and removes an active alias group", async () => {
  let calls = 0,
    picks = 0,
    subscriptions = 0,
    released = 0;
  let invalidate: (() => void) | undefined;
  const source = {
    trigger: "/",
    aliases: ["#"],
    name: "native",
    candidates: async () => {
      calls++;
      return [{ name: "native" }];
    },
    onPick: () => {
      picks++;
      return "handled";
    },
    codec: { clipboardText: (ref: string) => ref, serialize: async (ref: string) => ref },
    subscribeCandidates: (_session: unknown, listener: () => void) => {
      subscriptions++;
      invalidate = listener;
      return () => {
        released++;
      };
    },
  };
  const controller = new InputTriggerController({
    actx: {},
    sessionId: "existing",
    roster: {
      all: () => [source],
      sources: (trigger: string) => (sourceMatchesTrigger(source, trigger) ? [source] : []),
    },
  });
  const settle = () => new Promise<undefined>((resolve) => setImmediate(resolve, undefined));
  controller.track("#", 1, { tier: "plain" }, 1);
  await settle();
  assert.equal(calls, 1);
  assert.equal(subscriptions, 1);
  assert.equal(controller.menu.getSnapshot().groups.length, 1);
  assert.equal(
    await controller.serializeReference("native", "carrier", new AbortController().signal),
    "carrier",
  );
  assert.equal(controller.arbitrate("enter", true), "pass");
  assert.equal(picks, 0);
  invalidate?.();
  await settle();
  assert.equal(calls, 2);
  controller.sourceRemoved(source);
  assert.equal(controller.menu.getSnapshot().open, false);
  assert.equal(released, 1);
  controller.dispose();
  assert.equal(released, 1);
});

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

it("matches reference hash queries and preserves the exact caret span", () => {
  for (const [text, query, start] of [
    ["#", "", 0],
    ["#native", "native", 0],
    ["#123", "123", 0],
    ["＃123", "123", 0],
    ["#1skill", "1skill", 0],
    ["#" + "a".repeat(80), "a".repeat(80), 0],
    ["before #fake", "fake", 7],
    ["line\n#skill", "skill", 5],
    ["#/compact", "/compact", 0],
    ["#" + "a".repeat(32), "a".repeat(32), 0],
    ["请#native", "native", 1],
    ["帮我，#native", "native", 3],
    ["「#native", "native", 1],
    ["カタカナで#native", "native", 5],
    ["＃native", "native", 0],
    ["请＃native", "native", 1],
    ["```py\nx\n```\n#native", "native", 12],
    ["```foo```\n#native", "native", 10],
    ["```foo``` #native", "native", 10],
    ["use `a` #native", "native", 8],
    ["use \\` literal #native", "native", 15],
    ["use \\\\\\` literal #native", "native", 17],
    ["`a\\` #native", "native", 5],
    ["`alpha\nbeta` #native", "native", 13],
    ["`alpha\n\n#native", "native", 8],
    ["`alpha\n```py\n```\n#native", "native", 17],
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

it("leaves Markdown headings and code, escaped text, words and URL fragments alone", () => {
  for (const text of [
    "# ",
    "# heading",
    "##",
    "###native",
    "##/native",
    "＃＃",
    "＃＃native",
    "#＃",
    "＃#",
    "请＃＃",
    "before#native",
    "(#native",
    "\\#native",
    "https://host/#native",
    "https://host/#/compact",
    "path/#native",
    "C#",
    "issue#12",
    "&#39;",
    "한국어#native",
    "Ａ#native",
    "·#native",
    "```py\n#native",
    "```\n#/compact",
    "~~~foo~~~\n#native",
    "use `#native",
    "use \\\\`code #native",
    "`alpha\n#native",
    "`alpha\n  #native",
    "`@foo #bar",
    "` @foo #bar",
    '` @"foo #bar',
    "```py\n@dataclass",
    "```sh\n/bin/sh",
    "`/bin/sh",
    "`#/compact",
    "`alpha\n@file",
    "`alpha\n/cmd",
    "`a #foo`",
    "`a @foo`",
    "`a /cmd`",
  ])
    assert.equal(detectTrigger(text, text.length, { tier: "plain" }), null, text);
  assert.equal(detectTrigger("#native", 7, { tier: "frozen" }), null);
  assert.equal(detectTrigger("#native", 7, { tier: "claimed" })?.trigger, "#");
  assert.equal(detectTrigger("/native", 7, { tier: "plain" })?.trigger, "/");
  assert.equal(detectTrigger("/native#suffix", 14, { tier: "plain" })?.trigger, "/");
  assert.equal(detectTrigger("@file", 5, { tier: "plain" })?.trigger, "@");
  assert.equal(detectTrigger("use `a` @file", 13, { tier: "plain" })?.trigger, "@");
  assert.equal(detectTrigger("use `a` /cmd", 12, { tier: "plain" })?.trigger, "/");
  assert.equal(detectTrigger("```py\nx\n```\n@file", 17, { tier: "plain" })?.trigger, "@");
  assert.equal(detectTrigger("```sh\nx\n```\n/cmd", 16, { tier: "plain" })?.trigger, "/");
});

it("normalizes fullwidth ＃ in onSpace and adjudicate for leading hash sources", async () => {
  const spaceTokens: string[] = [];
  const enterLines: string[] = [];
  const source = {
    trigger: "#",
    name: "hash-command",
    candidates: async () => [],
    onPick: () => undefined,
    matchSpace: (_session: unknown, token: string) => {
      spaceTokens.push(token);
      return "handled" as const;
    },
    matchEnter: async (_session: unknown, line: string) => {
      enterLines.push(line);
      return "handled" as const;
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
  try {
    controller.track("＃compact", 8, { tier: "plain" }, 1);
    assert.equal(controller.onSpace(), true);
    assert.deepEqual(spaceTokens, ["#compact"]);

    const outcome = await controller.adjudicate("＃compact arg", new AbortController().signal, {
      attachments: 0,
    });
    assert.equal(outcome, "handled");
    assert.deepEqual(enterLines, ["#compact arg"]);
  } finally {
    controller.dispose();
  }
});

for (const trigger of ["/", "@", "#"])
  for (const fails of [false, true])
    it(`keeps unchanged ${trigger} closed after ${fails ? "failed" : "empty"} candidates`, async (t) => {
      if (fails) t.mock.method(console, "error", () => {});
      let calls = 0;
      let invalidate: (() => void) | undefined;
      const source = {
        trigger,
        name: "native",
        candidates: async () => {
          calls++;
          if (fails) throw new Error("discovery unavailable");
          return [];
        },
        onPick: () => undefined,
        subscribeCandidates: (_session: unknown, listener: () => void) => {
          invalidate = listener;
          return () => {};
        },
      };
      const controller = new InputTriggerController({
        actx: {},
        sessionId: "existing",
        roster: { all: () => [source], sources: () => [source] },
      });
      const settle = () => new Promise<undefined>((resolve) => setImmediate(resolve, undefined));
      const path = `${trigger === "/" ? "" : trigger}/Users/example/work/project/.agents/skills`;
      const draft = `${path}\nWorkspace: https://example.test/session\nordinary text`;
      const track = (text = draft, caret = path.length, rev = 1) =>
        controller.track(text, caret, { tier: "plain" }, rev);
      let opens = 0;
      const off = controller.menu.subscribe(() => {
        if (controller.menu.getSnapshot().open) opens++;
      });
      try {
        track();
        await settle();
        assert.equal(calls, 1);
        assert.equal(controller.menu.getSnapshot().open, false);
        const initialOpens = opens;
        // Selection-only commits and catalog notifications must not restart an
        // empty query, even when an unrelated draft edit advances its revision.
        for (let i = 0; i < 3; i++) {
          invalidate?.();
          track(`${draft}!`, path.length, 2);
          await settle();
          assert.equal(controller.menu.getSnapshot().open, false);
        }
        assert.equal(calls, 1);
        assert.equal(opens, initialOpens, "no transient loading menu on re-track");

        track(draft, path.length - 1, 3);
        await settle();
        assert.equal(calls, 2, "a changed query can fetch again");
        track(draft, draft.length, 3);
        track();
        await settle();
        assert.equal(calls, 3, "leaving and returning to the token re-arms discovery");

        controller.toggleSource("native", {
          trigger,
          query: "",
          quoted: false,
          position: "leading",
          span: { start: 0, end: 0, draftRev: 3 },
        });
        await settle();
        assert.equal(calls, 4, "an explicit launcher can still open");
        assert.equal(controller.menu.getSnapshot().open, true);
      } finally {
        off();
        controller.dispose();
      }
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

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evaluate, parseAppcast, readPins, recoveredPinIssues } from "./run.mjs";
import { describe, it } from "node:test";

const files = {
  clientOwned: `
export const CLIENT_OWNED_VOICE_VERSION = "26.1016.51333";
export const CLIENT_OWNED_VOICE_INITIAL_ASSET = "app-initial-f3e281fb9a71.js";
export const CLIENT_OWNED_VOICE_SHARED_ASSET = "app-shared-60f4bb85435f.js";
`,
  nativeChat: `
const NATIVE_CHAT_VOICE_VERSION = "26.1013.40934";
const NATIVE_CHAT_INITIAL_ASSET = "app-initial-90eb42395b7d.js";
const START_ASSET = "start-voice-954090654801.js";
`,
  voiceStart: `export const VOICE_START_OVERLAY_ASSET = "avatar-overlay-native-page-48cbc35fadc8.js";`,
};

describe("compat-daily pins", () => {
  it("identifies resolved pin issues without declaring live acceptance", () => {
    const pins = { ...readPins(files), chatVersion: "26.1016.61520" };
    const report = evaluate(pins, { version: "26.1016.61520", build: "21421" });
    const issues = [
      {
        number: 4,
        title: "compat-daily/chat-voice: pin 26.1013.40934 behind desktop 26.1016.61520",
      },
      {
        number: 5,
        title: "compat-daily/work-voice: pin 26.1016.51333 behind desktop 26.1016.61520",
      },
      { number: 6, title: "Chat voice fails to connect" },
      { number: 7, title: "compat-daily/chat-voice: pin old behind desktop new", pull_request: {} },
    ];
    assert.deepEqual(recoveredPinIssues(report, issues), [
      { number: 4, surface: "chat-voice", version: "26.1016.61520" },
    ]);
    assert.deepEqual(
      recoveredPinIssues(
        { ...report, latest: { version: "26.1016.62342", build: "21477" } },
        issues,
      ),
      [{ number: 4, surface: "chat-voice", version: "26.1016.61520" }],
    );
  });
  it("reads Renderer voice pins from source", () => {
    assert.deepEqual(readPins(files), {
      workVersion: "26.1016.51333",
      workInitial: "app-initial-f3e281fb9a71.js",
      workShared: "app-shared-60f4bb85435f.js",
      overlayAsset: "avatar-overlay-native-page-48cbc35fadc8.js",
      chatVersion: "26.1013.40934",
      chatInitial: "app-initial-90eb42395b7d.js",
      chatStart: "start-voice-954090654801.js",
    });
  });

  it("parses the first Sparkle item", () => {
    const xml = `<?xml version="1.0"?>
<rss><channel>
<item>
  <sparkle:version>21421</sparkle:version>
  <sparkle:shortVersionString>26.1016.61520</sparkle:shortVersionString>
</item>
<item>
  <sparkle:shortVersionString>26.1016.51333</sparkle:shortVersionString>
</item>
</channel></rss>`;
    assert.deepEqual(parseAppcast(xml), { version: "26.1016.61520", build: "21421" });
  });

  it("reports Chat and Work when Sparkle is ahead of both pins", () => {
    const report = evaluate(readPins(files), { version: "26.1016.61520", build: "21421" });
    assert.equal(report.findings.length, 2);
    assert.equal(report.findings[0]?.surface, "work-voice");
    assert.equal(report.findings[1]?.surface, "chat-voice");
    assert.match(report.findings[1]?.title ?? "", /chat-voice/);
  });

  it("keeps Chat drift visible when Work already matches 61520", () => {
    const pins = readPins({
      ...files,
      clientOwned: files.clientOwned.replaceAll("26.1016.51333", "26.1016.61520"),
    });
    const report = evaluate(pins, { version: "26.1016.61520", build: "21421" });
    assert.deepEqual(
      report.findings.map((finding) => finding.surface),
      ["chat-voice"],
    );
    assert.match(report.findings[0].detail, /26\.1013\.40934/);
    assert.match(report.findings[0].detail, /unqualified/);
  });

  it("falls back Chat pins to Work when Chat reuses CLIENT_OWNED_*", () => {
    const pins = readPins({
      ...files,
      nativeChat: `const START_ASSET = "start-voice-954090654801.js";\n`,
      voiceStart: "",
    });
    assert.equal(pins.chatVersion, "26.1016.51333");
    assert.equal(pins.chatInitial, "app-initial-f3e281fb9a71.js");
    assert.equal(pins.overlayAsset, undefined);
  });

  it("is quiet when Sparkle matches both pins", () => {
    const matched = {
      ...files,
      nativeChat: files.nativeChat.replace("26.1013.40934", "26.1016.51333"),
    };
    const report = evaluate(readPins(matched), { version: "26.1016.51333", build: "21161" });
    assert.equal(report.findings.length, 0);
  });
});

// Exercise the actual workflow scripts so moving code across step boundaries
// cannot leave issue creation or recovery dependent on another step's locals.
it("runs drift and recovery workflow steps in separate scopes", async () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/compat-daily.yml", import.meta.url),
    "utf8",
  );
  const steps = workflow.split("      - name: ");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const issue = {
    number: 4,
    title: "compat-daily/chat-voice: pin 26.1013.40934 behind desktop 26.1016.61520",
  };
  const report = evaluate(
    { ...readPins(files), chatVersion: "26.1016.61520" },
    { version: "26.1016.62342", build: "21477" },
  );
  const created = [];
  const comments = [];
  const github = {
    rest: {
      issues: {
        getLabel: async () => ({}),
        listForRepo: async () => ({ data: [issue] }),
        listComments: async () => ({ data: comments }),
        create: async (args) => created.push(args),
        createComment: async (args) => comments.push({ ...args, user: { type: "Bot" } }),
      },
    },
    paginate: async (method, args) => (await method(args)).data,
  };
  const run = async (name) => {
    const step = steps.find((step) => step.startsWith(name + "\n"));
    assert.ok(step, name);
    const script = step
      .split("          script: |\n")[1]
      .split("\n")
      .map((line) => line.slice(12))
      .join("\n");
    await new AsyncFunction("require", "github", "context", "process", script)(
      () => ({ readFileSync: () => JSON.stringify(report) }),
      github,
      {
        repo: { owner: "karlorz", repo: "codex-host" },
        serverUrl: "https://github.com",
        runId: 1,
        eventName: "push",
      },
      { env: { GITHUB_WORKSPACE: fileURLToPath(new URL("../../", import.meta.url)) } },
    );
  };
  await run("Open or update issues on pin drift");
  assert.equal(created.length, 2);
  await run("Comment on matching voice pins");
  assert.equal(comments.length, 1);
  assert.equal(comments[0].issue_number, 4);
  assert.match(comments[0].body, /does not verify microphone/);
  await run("Comment on matching voice pins");
  assert.equal(comments.length, 1);
});

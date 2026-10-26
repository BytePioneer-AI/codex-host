import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, loadPinsFromRepo, parseAppcast, readPins, recoveredPinIssues } from "./run.mjs";
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

  it("does not report a rolled-back feed as newer than either pin", () => {
    assert.deepEqual(
      evaluate(readPins(files), { version: "26.1007.30912", build: "21000" }).findings,
      [],
    );
  });

  it("orders each version component numerically and evaluates surfaces independently", () => {
    const pins = { ...readPins(files), workVersion: "26.9.100", chatVersion: "26.10.10" };
    assert.deepEqual(
      evaluate(pins, { version: "26.10.9", build: "1" }).findings.map((f) => f.surface),
      ["work-voice"],
    );
    assert.deepEqual(evaluate(pins, { version: "25.9999.99999", build: "1" }).findings, []);
    assert.equal(evaluate(pins, { version: "27.1.1", build: "1" }).findings.length, 2);
    assert.equal(evaluate(pins, { version: "26.10.100", build: "1" }).findings.length, 2);
    assert.deepEqual(
      evaluate(
        { ...pins, workVersion: "26.010.009", chatVersion: "26.10.9" },
        { version: "26.10.9", build: "1" },
      ).findings,
      [],
    );
  });

  it("rejects malformed feed and pin versions even when the strings match", () => {
    for (const version of ["unknown", "26.10", "26.10.1.0", "26..1", "26.10.-1", "26.10.1x"]) {
      const pins = readPins(files);
      assert.throws(() => evaluate(pins, { version, build: "1" }), /Invalid.*version/u);
      for (const surface of ["workVersion", "chatVersion"]) {
        assert.throws(
          () => evaluate({ ...pins, [surface]: version }, { version, build: "1" }),
          /Invalid.*version/u,
        );
        assert.throws(
          () => evaluate({ ...pins, [surface]: version }, { version: "26.10.1", build: "1" }),
          /Invalid.*version/u,
        );
      }
    }
  });
});

// Exercise the actual workflow scripts so moving code across step boundaries
// cannot leave issue creation or recovery dependent on another step's locals.
async function workflowFixture(report, issues = []) {
  const workflow = readFileSync(
    new URL("../../.github/workflows/compat-daily.yml", import.meta.url),
    "utf8",
  );
  const steps = workflow.split("      - name: ");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const created = [];
  const comments = [];
  const github = {
    rest: {
      issues: {
        getLabel: async () => ({}),
        listForRepo: async () => ({ data: issues }),
        listComments: async () => ({ data: comments }),
        create: async (args) => created.push(args),
        createComment: async (args) => comments.push({ ...args, user: { type: "Bot" } }),
      },
    },
    paginate: async (method, args) => (await method(args)).data,
  };
  const run = async (
    name,
    eventName = "push",
    ref = "refs/heads/stable",
    compareOutcome = "failure",
  ) => {
    const step = steps.find((step) => step.startsWith(name + "\n"));
    assert.ok(step, name);
    const githubContext = {
      event_name: eventName,
      ref,
      event: { repository: { default_branch: "stable" } },
    };
    const condition = step.match(/^ {8}if: (.+)$/mu)?.[1];
    assert.ok(condition, name);
    const allowed = new Function(
      "github",
      "steps",
      "failure",
      "always",
      "format",
      `return (${condition});`,
    )(
      githubContext,
      { compare: { outcome: compareOutcome } },
      () => compareOutcome === "failure",
      () => true,
      (template, value) => template.replace("{0}", value),
    );
    if (!allowed) return;
    const script = step
      .split("          script: |\n")[1]
      .split(/\n(?=\S| {1,10}\S)/u)[0]
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
        eventName,
        ref,
        sha: "checked-sha",
      },
      { env: { GITHUB_WORKSPACE: new URL("../..", import.meta.url).href } },
    );
  };
  return { run, created, comments };
}

it("runs drift and recovery workflow steps in separate scopes", async () => {
  const issue = {
    number: 4,
    title: "compat-daily/chat-voice: pin 26.1013.40934 behind desktop 26.1016.61520",
  };
  const report = evaluate(
    { ...readPins(files), chatVersion: "26.1016.61520" },
    { version: "26.1016.62342", build: "21477" },
  );
  const { run, created, comments } = await workflowFixture(report, [issue]);
  await run("Open or update issues on pin drift");
  assert.equal(created.length, 2);
  assert.match(created[0].body, /macOS/u);
  assert.match(created[0].body, /checked-sha/u);
  assert.match(created[0].body, /refs\/heads\/stable/u);
  await run("Comment on matching voice pins", "workflow_dispatch", "refs/heads/stable", "success");
  assert.equal(comments.length, 1);
  assert.equal(comments[0].issue_number, 4);
  assert.match(comments[0].body, /does not verify microphone/);
  assert.match(comments[0].body, /checked-sha/u);
  assert.match(comments[0].body, /refs\/heads\/stable/u);
  await run("Comment on matching voice pins");
  assert.equal(comments.length, 1);

  const duplicate = await workflowFixture(report, [{ title: report.findings[0].title, number: 9 }]);
  await duplicate.run("Open or update issues on pin drift");
  assert.match(duplicate.comments[0].body, /checked-sha/u);
  assert.match(duplicate.comments[0].body, /refs\/heads\/stable/u);
});

it("does not publish drift or recovery from PRs or non-default branches", async () => {
  const report = evaluate(readPins(files), { version: "26.1016.62342", build: "21477" });
  const issue = {
    number: 4,
    title: `compat-daily/chat-voice: pin old behind desktop ${report.pins.chatVersion}`,
  };
  for (const [event, ref] of [
    ["pull_request", "refs/pull/1/merge"],
    ["pull_request", "refs/heads/stable"],
    ["workflow_dispatch", "refs/heads/unmerged-review"],
    ["workflow_dispatch", "refs/tags/stable"],
    ["push", "refs/heads/main"],
  ]) {
    const { run, created, comments } = await workflowFixture(report, [issue]);
    await run("Open or update issues on pin drift", event, ref);
    await run("Comment on matching voice pins", event, ref);
    assert.deepEqual({ created, comments }, { created: [], comments: [] }, `${event}: ${ref}`);
  }
});

it("skips both issue steps for structured operational errors", async () => {
  const report = { error: "Appcast HTTP 503", findings: [] };
  const { run, created, comments } = await workflowFixture(report);
  await run("Open or update issues on pin drift", "workflow_dispatch");
  await run("Comment on matching voice pins", "workflow_dispatch");
  assert.deepEqual({ created, comments }, { created: [], comments: [] });
});

it("prints structured JSON and fails for fetch, parse and pin-loading errors", () => {
  const entry = fileURLToPath(new URL("./run.mjs", import.meta.url));
  const assertFailure = (args, message) => {
    const result = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.match(report.error, message);
    assert.deepEqual(report.findings, []);
    assert.match(result.stderr, message);
    assert.equal(report.latest, undefined);
  };
  for (const [mock, message] of [
    ['throw new Error("simulated feed failure")', /simulated feed failure/u],
    ["return {ok:false,status:503}", /Appcast HTTP 503/u],
    ['return {ok:true,text:async()=>"invalid XML"}', /Appcast has no item/u],
    [
      'return {ok:true,text:async()=>"<item><sparkle:shortVersionString>invalid</sparkle:shortVersionString><sparkle:version>1</sparkle:version></item>"}',
      /Invalid.*version/u,
    ],
  ]) {
    const preload = `data:text/javascript,${encodeURIComponent(`globalThis.fetch = async () => {${mock}};`)}`;
    assertFailure(["--import", preload, entry], message);
  }
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "compat-daily-")));
  try {
    const directory = path.join(root, "tools", "compat-daily");
    mkdirSync(directory, { recursive: true });
    const copy = path.join(directory, "run.mjs");
    copyFileSync(entry, copy);
    assertFailure([copy], /ENOENT/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("recognizes the audited 26.1021 Work and relocated native Chat pins", async () => {
  const pins = await loadPinsFromRepo();
  const report = evaluate(pins, { version: "26.1021.31345", build: "21828" });
  assert.equal(pins.workVersion, "26.1021.31345");
  assert.equal(pins.chatVersion, "26.1021.31345");
  assert.equal(pins.overlayAsset, "avatar-overlay-native-page-d549db3706f1.js");
  assert.equal(pins.chatStart, "entity-business-profile-reference-b68063dfc05d.js");
  assert.deepEqual(report.findings, []);
  assert.deepEqual(
    recoveredPinIssues(report, [
      {
        number: 9,
        title: "compat-daily/work-voice: pin 26.1016.62342 behind desktop 26.1021.31345",
      },
      {
        number: 10,
        title: "compat-daily/chat-voice: pin 26.1016.62342 behind desktop 26.1021.31345",
      },
    ]),
    [
      { number: 9, surface: "work-voice", version: "26.1021.31345" },
      { number: 10, surface: "chat-voice", version: "26.1021.31345" },
    ],
  );
});

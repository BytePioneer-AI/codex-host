import { afterEach, expect, it, vi } from "vitest";
import type { JsonObject } from "@codexhost/protocol-core";
import { harnessCommandMentionPath } from "@codexhost/shared-contracts";
import {
  nativeThreadCommands,
  nativeThreadSkillInput,
} from "../src/codex-runtime/native-thread-controls.js";
import { createFixture, stopFixture } from "./app-server-host-fixture.js";

const workspaceSkill = {
  name: "build",
  description: "Build it",
  path: "/workspace/.agents/skills/build/SKILL.md",
  enabled: true,
};
const skills: JsonObject = {
  data: [
    {
      cwd: "/workspace",
      skills: [
        workspaceSkill,
        { ...workspaceSkill, path: "/home/user/.codex/skills/build/SKILL.md" },
        { ...workspaceSkill, name: "bad/name" },
        { ...workspaceSkill, name: "build " },
        { ...workspaceSkill, name: "missing-path", path: null },
        { ...workspaceSkill, name: "hidden", enabled: false },
        { ...workspaceSkill, name: "test", description: "  " },
      ],
      errors: [{ path: "/workspace/broken/SKILL.md", message: "Invalid frontmatter" }],
    },
  ],
};

it("keeps built-ins and valid Skills when official discovery includes duplicate names, bad entries and Skill errors", () => {
  const catalog = nativeThreadCommands(skills);
  expect(catalog.commands.map(({ id }) => id)).toEqual([
    "compact",
    "review",
    "skill:build",
    "skill:test",
  ]);
  expect(catalog.commands[1]).toMatchObject({ invocation: "/review", argumentMode: "none" });
  expect(catalog.commands[3]).not.toHaveProperty("description");
  expect(catalog.warnings).toEqual([
    expect.stringContaining("Invalid frontmatter"),
    expect.stringContaining("Skipped duplicate Skill 'build'"),
    expect.stringContaining("bad/name"),
    expect.stringContaining('"build "'),
    expect.stringContaining("missing-path"),
  ]);
  expect(nativeThreadSkillInput(skills, "build")).toEqual({
    type: "skill",
    name: "build",
    path: workspaceSkill.path,
  });
  expect(nativeThreadSkillInput(skills, "hidden")).toBeUndefined();
  expect(nativeThreadCommands({}).commands).toHaveLength(2);
  expect(nativeThreadCommands({}).warnings).toEqual(["Codex returned an invalid Skills list"]);
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function officialFixture() {
  const fixture = createFixture({ externalOnly: true });
  cleanup.push(() => stopFixture(fixture));
  const calls: Array<{ method: string; params: JsonObject }> = [];
  const failures = new Map<string, string>();
  let buffer = "";
  fixture.official.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const request = JSON.parse(buffer.slice(0, end)) as JsonObject;
      buffer = buffer.slice(end + 1);
      const method = String(request.method),
        params = (request.params ?? {}) as JsonObject;
      calls.push({ method, params });
      const failure = failures.get(method);
      const result =
        method === "thread/read"
          ? { thread: { id: "official", cwd: "/workspace" } }
          : method === "skills/list"
            ? skills
            : method === "review/start" || method === "turn/start"
              ? { turn: { id: "native-turn" } }
              : {};
      fixture.official.stdout.write(
        `${JSON.stringify({
          id: request.id,
          ...(failure ? { error: { code: -32600, message: failure } } : { result }),
        })}\n`,
      );
    }
  });
  await vi.waitFor(async () => expect(await fixture.mappingStore.listThreads()).toEqual([]));
  const send = (method: string, params: JsonObject = {}) =>
    fixture.host.handleClientRequest(method, { threadId: "official", ...params });
  return { calls, failures, send };
}

it("loads a partial native catalog through the client route and retains compact/review when skills/list fails", async () => {
  const { calls, failures, send } = await officialFixture();
  const loaded = await send("codexhost/thread/commands/inspect");
  expect(loaded).toMatchObject({ result: nativeThreadCommands(skills) });
  expect(calls).toContainEqual({ method: "skills/list", params: { cwds: ["/workspace"] } });
  failures.set("skills/list", "Skills service failed");
  expect(await send("codexhost/thread/commands/inspect")).toMatchObject({
    result: {
      commands: [{ id: "compact" }, { id: "review" }],
      warnings: ["Codex Skills unavailable: Skills service failed"],
    },
  });
  expect(calls.some(({ method }) => ["thread/resume", "turn/start"].includes(method))).toBe(false);
  expect(await send("codexhost/thread/command/execute", { commandId: "compact" })).toEqual({
    result: { accepted: true },
  });
});

it("uses official compact/review methods, returns real Turn IDs and preserves native refusal without a prompt fallback", async () => {
  const { calls, failures, send } = await officialFixture();
  expect(await send("codexhost/thread/command/execute", { commandId: "compact" })).toEqual({
    result: { accepted: true },
  });
  expect(await send("turn/start", { input: [{ type: "text", text: "/review" }] })).toEqual({
    result: { accepted: true, turnId: "native-turn" },
  });
  const carrier = `[@/review](${harnessCommandMentionPath("/review")})`;
  expect(
    await send("turn/start", {
      input: [{ type: "text", text: `File context\n${carrier} check  tests\tcarefully` }],
    }),
  ).toMatchObject({ result: { accepted: true } });
  expect(calls).toContainEqual({
    method: "thread/compact/start",
    params: { threadId: "official" },
  });
  expect(calls.filter(({ method }) => method === "review/start")).toEqual([
    {
      method: "review/start",
      params: { threadId: "official", target: { type: "uncommittedChanges" }, delivery: "inline" },
    },
    {
      method: "review/start",
      params: {
        threadId: "official",
        target: { type: "custom", instructions: "File context\n check  tests\tcarefully" },
        delivery: "inline",
      },
    },
  ]);
  failures.set("review/start", "No repository");
  expect(await send("codexhost/thread/command/execute", { commandId: "review" })).toEqual({
    error: { code: -32600, message: "No repository" },
  });
  failures.set("thread/resume", "thread official already has an active writer");
  const count = calls.length;
  expect(await send("codexhost/thread/command/execute", { commandId: "compact" })).toHaveProperty(
    "error.message",
    "thread official already has an active writer",
  );
  expect(calls.slice(count).map(({ method }) => method)).toEqual(["thread/resume"]);
  expect(
    await send("turn/start", { input: [{ type: "text", text: "/compact ignored?" }] }),
  ).toHaveProperty("error.message", "Codex compact does not accept arguments");
  expect(
    await send("turn/start", { delivery: "queue", input: [{ type: "text", text: "/review" }] }),
  ).toHaveProperty("error");
  expect(await send("turn/steer", { input: [{ type: "text", text: "/review" }] })).toHaveProperty(
    "error",
  );
  expect(
    calls.some(({ method }) => ["turn/start", "turn/steer", "thread/queue/add"].includes(method)),
  ).toBe(false);
});

it("sends selected Skills as official name/path inputs with text, attachments, queue and steer semantics intact", async () => {
  const { calls, failures, send } = await officialFixture();
  const carrier = `[@$build](${harnessCommandMentionPath("$build")})`;
  for (const mode of ["send", "queue", "steer"] as const) {
    expect(
      await send(mode === "steer" ? "turn/steer" : "turn/start", {
        input: [
          {
            type: "text",
            text: `# File context\n${carrier} preserve  spaces\tand\n  indentation`,
            text_elements: [],
          },
          { type: "localImage", path: "/workspace/screen.png" },
        ],
        ...(mode === "queue" ? { delivery: "queue" } : {}),
        ...(mode === "steer" ? { expectedTurnId: "active-turn" } : {}),
      }),
    ).not.toHaveProperty("error");
    const sent = calls
      .filter(({ method }) => ["turn/start", "turn/steer", "thread/queue/add"].includes(method))
      .at(-1);
    expect(sent?.method).toBe(
      mode === "steer" ? "turn/steer" : mode === "queue" ? "thread/queue/add" : "turn/start",
    );
    expect(sent?.params.input).toEqual([
      {
        type: "text",
        text: "$build # File context\n preserve  spaces\tand\n  indentation",
        text_elements: [],
      },
      { type: "localImage", path: "/workspace/screen.png" },
      { type: "skill", name: "build", path: workspaceSkill.path },
    ]);
    if (mode === "steer") expect(sent?.params.expectedTurnId).toBe("active-turn");
  }
  const writes = () =>
    calls.filter(({ method }) => ["turn/start", "turn/steer", "thread/queue/add"].includes(method))
      .length;
  expect(writes()).toBe(3);
  expect(
    await send("turn/start", {
      input: [{ type: "text", text: `[@$hidden](${harnessCommandMentionPath("$hidden")}) do it` }],
    }),
  ).toHaveProperty("error.message", "Codex Skill 'hidden' is unavailable");
  failures.set("skills/list", "Skills offline");
  expect(await send("turn/start", { input: [{ type: "text", text: carrier }] })).toHaveProperty(
    "error.message",
    "Skills offline",
  );
  expect(writes()).toBe(3);
});

it("keeps the explicit Skill path on queued input edits without duplicating or re-resolving it", async () => {
  const { calls, send } = await officialFixture();
  const input = [
    { type: "text", text: "$build edited arguments", text_elements: [] },
    { type: "skill", name: "build", path: "/workspace/selected/SKILL.md" },
  ];
  expect(
    await send("thread/queue/update", { queuedSubmissionId: "queued", input }),
  ).not.toHaveProperty("error");
  expect(calls).toContainEqual({
    method: "thread/queue/update",
    params: { threadId: "official", queuedSubmissionId: "queued", input },
  });
  expect(calls.some(({ method }) => method === "skills/list")).toBe(false);
});

it("does not interpret ordinary dollar-prefixed text as a selected Skill", async () => {
  const { calls, failures, send } = await officialFixture();
  failures.set("skills/list", "Unavailable");
  const input = [
    { type: "text", text: "$HOME is the directory I want to discuss", text_elements: [] },
  ];
  expect(await send("turn/start", { input })).not.toHaveProperty("error");
  expect(calls).toContainEqual({ method: "turn/start", params: { threadId: "official", input } });
  expect(calls.some(({ method }) => method === "skills/list")).toBe(false);
});

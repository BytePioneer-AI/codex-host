// Opt-in local native protocol check. No provider credentials or model prompts are used.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { KimiCodeAdapter } from "../dist/index.js";

const root = await mkdtemp(path.join(tmpdir(), "codexhost-kimi-smoke-"));
const cwd = path.join(root, "workspace"),
  profile = path.join(root, "profile");
await Promise.all([mkdir(cwd), mkdir(profile)]);
const allowed = new Set([
  "path",
  "pathext",
  "systemroot",
  "windir",
  "comspec",
  "temp",
  "tmp",
  "userprofile",
  "localappdata",
  "appdata",
  "programfiles",
  "programfiles(x86)",
]);
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())),
);
environment.KIMI_CODE_HOME = profile;
environment.NO_COLOR = "1";
const adapters = [];
try {
  const first = new KimiCodeAdapter({ environment });
  adapters.push(first);
  const inspection = await first.inspect({ cwd });
  assert.equal(inspection.status, "unavailable");
  assert.equal(inspection.error.code, "authenticationRequired");
  const created = await first.open({ kind: "create", cwd });
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  const session = created.value;
  const snapshot = await session.readSnapshot();
  if (!snapshot.ok) throw new Error(JSON.stringify(snapshot.error));
  assert.equal(snapshot.value.turns.length, 0);
  const ref = session.initialState.nativeRef;
  assert.ok(ref);
  if (process.argv.includes("--negative-turn")) {
    // Readiness was checked above in a newly created empty profile. This exercises
    // native rejection/persistence, never an authenticated model generation.
    const terminal = (async () => {
      for await (const output of session.outputs) {
        if (output.kind === "event" && output.event.type === "turn.completed") return output.event;
      }
      throw new Error("No native turn terminal event");
    })();
    const submitted = await session.execute({
      type: "turn.start",
      turnId: "native-negative-probe",
      input: [{ type: "text", text: "Protocol check." }],
    });
    assert.equal(submitted.ok, true);
    const timer = setTimeout(() => {
      void session.close();
    }, 12_000);
    try {
      const ended = await terminal;
      assert.equal(ended.outcome.status, "failed");
      assert.ok(ended.nativeTurnRef);
      const failedHistory = await session.readSnapshot();
      assert.equal(failedHistory.ok, true);
      if (failedHistory.ok) {
        assert.equal(failedHistory.value.turns.length, 1);
        assert.deepEqual(failedHistory.value.turns[0].nativeTurnRef, ended.nativeTurnRef);
        assert.equal(failedHistory.value.turns[0].outcome.status, "failed");
        snapshot.value.turns = failedHistory.value.turns;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  await first.close();
  const second = new KimiCodeAdapter({ environment });
  adapters.push(second);
  const resumed = await second.open({ kind: "resume", cwd, nativeRef: ref });
  if (!resumed.ok) throw new Error(JSON.stringify(resumed.error));
  assert.deepEqual(resumed.value.initialState.nativeRef, ref);
  const restored = await resumed.value.readSnapshot();
  assert.equal(restored.ok, true);
  // 2.0.2 drops the optional startedAt field when reconstructing a cold transcript.
  const persistent = (turns) => turns.map(({ startedAtMs: _started, ...turn }) => turn);
  if (restored.ok)
    assert.deepEqual(persistent(restored.value.turns), persistent(snapshot.value.turns));
  await second.close();
  console.log(
    JSON.stringify({
      version: "2.0.2",
      isolatedProfile: true,
      isolatedCwd: true,
      modelReady: false,
      create: true,
      read: true,
      reopen: true,
      promptSubmissions: process.argv.includes("--negative-turn") ? 1 : 0,
      authenticatedModelGenerations: 0,
      cleanup: true,
    }),
  );
} finally {
  await Promise.all(adapters.map((adapter) => adapter.close()));
  const resolved = path.resolve(root);
  assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep));
  assert.ok(path.basename(resolved).startsWith("codexhost-kimi-smoke-"));
  await rm(resolved, { recursive: true, force: true });
}

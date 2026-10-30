import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { HermesGatewayHistory, projectGatewayHistory } from "../src/gateway-history.js";

const run = promisify(execFile);
const rows = [
  { id: 10, original_id: 10, role: "user", content: "same", user_text: "same", timestamp: 100 },
  {
    id: 11,
    original_id: 11,
    role: "assistant",
    content: "",
    reasoning_content: "plan",
    tool_calls: [{ id: "call-1", function: { name: "terminal", arguments: '{"command":"pwd"}' } }],
  },
  { id: 12, original_id: 12, role: "tool", tool_call_id: "call-1", content: '{"output":"/tmp"}' },
  { id: 13, original_id: 13, role: "assistant", content: "done" },
  { id: 14, original_id: 14, role: "user", content: "same", user_text: "same", timestamp: 101 },
];

describe("Hermes durable gateway history", () => {
  it("preserves real user identity, tool arguments and complete tool output", () => {
    const snapshot = projectGatewayHistory("s", {
      rows,
      derivable: true,
      boundaries: { "10": { count: 4, digest: "proof" } },
    });
    expect(snapshot.turns.map((t) => t.nativeTurnRef.nativeTurnKey)).toEqual(["10", "14"]);
    expect(snapshot.turns[0]?.checkpoint?.locator).toEqual({ count: 4, digest: "proof" });
    expect(snapshot.turns[0]?.items.map((i) => i.item.type)).toEqual([
      "reasoning",
      "toolExecution",
      "agentMessage",
    ]);
    expect(snapshot.turns[0]?.items[1]?.item).toMatchObject({
      toolName: "terminal",
      arguments: { command: "pwd" },
      output: { content: [{ type: "text", text: '{"output":"/tmp"}' }] },
    });
    expect(snapshot.turns[1]?.outcome.status).toBe("unknown");
  });

  it("keeps original compacted identity but offers no lossy checkpoint", () => {
    const snapshot = projectGatewayHistory("s", {
      rows: [{ ...rows[0], id: 30, original_id: 10 }],
      derivable: false,
      boundaries: {},
    });
    expect(snapshot.turns[0]?.nativeTurnRef.nativeTurnKey).toBe("10");
    expect(snapshot.turns[0]?.checkpoint).toBeUndefined();
  });

  it("does not fabricate completion for a tool without a persisted result", () => {
    const snapshot = projectGatewayHistory("s", {
      rows: rows.slice(0, 2),
      derivable: false,
      boundaries: {},
    });
    expect(snapshot.turns[0]?.items.map((i) => i.item.type)).toEqual(["reasoning"]);
  });

  it("rejects a checkpoint from another native session before launching Python", async () => {
    const history = new HermesGatewayHistory({
      python: "nonexistent",
      cwd: os.tmpdir(),
      environment: {},
      nativeSessionId: "s",
    });
    await expect(
      history.derive({
        checkpoint: {
          harnessId: "hermes" as never,
          nativeSessionId: "other",
          checkpointId: "10",
          formatVersion: 1,
        },
      }),
    ).rejects.toThrow("another session");
  });
});

// Optional real installed SDK exercise; no downloaded code or user state is used
// by default. Point the environment variable at an installed Hermes interpreter.
const python = process.env.CODEXHOST_HERMES_NATIVE_TEST_PYTHON;
describe.skipIf(!python)("Hermes installed SessionDB integration", () => {
  it("creates, reads, forks and rolls back complete tool history without changing its source", async () => {
    if (!python) throw new Error("Missing Hermes native test interpreter");
    const home = await mkdtemp(path.join(os.tmpdir(), "hermes-history-test-"));
    const environment = { ...process.env, HERMES_HOME: home };
    const history = new HermesGatewayHistory({
      python: python,
      cwd: home,
      environment,
      nativeSessionId: "source",
    });
    const native = async (script: string) =>
      (await run(python, ["-I", "-c", script], { cwd: home, env: environment })).stdout
        .trim()
        .split("\n")
        .at(-1) ?? "";
    try {
      await history.ensureCreated({
        cwd: home,
        model: "test-model",
        provider: "test-provider",
        reasoningEffort: "high",
        yolo: false,
      });
      await history.ensureCreated({
        cwd: home,
        model: "should-not-overwrite",
        provider: "other-provider",
        reasoningEffort: "low",
        yolo: true,
      });
      const initial = JSON.parse(
        await native(
          "import json\nfrom hermes_state import SessionDB\ndb=SessionDB(read_only=True)\nprint(json.dumps(db.get_session('source')))\ndb.close()",
        ),
      );
      expect(initial.model).toBe("test-model");
      expect(JSON.parse(initial.model_config)).toMatchObject({
        provider: "test-provider",
        reasoning_config: { effort: "high" },
        yolo_mode: false,
      });
      expect((await history.readSnapshot()).turns).toEqual([]);
      await native(`from hermes_state import SessionDB
import json
db=SessionDB()
db.update_session_meta('source', json.dumps({'yolo_mode': True, 'reasoning_effort': 'high'}))
db.append_message('source','user',content='same',timestamp=100)
db.append_message('source','assistant',content='',reasoning_content='plan',tool_calls=[{'id':'call-1','type':'function','function':{'name':'terminal','arguments':'{"command":"pwd"}'}}],timestamp=101)
db.append_message('source','tool',content='{"output":"/tmp"}',tool_call_id='call-1',tool_name='terminal',timestamp=102)
db.append_message('source','assistant',content='done',timestamp=103)
db.append_message('source','user',content='[System: model changed]',timestamp=103.1)
db.append_message('source','user',content='synthetic continuation',display_kind='auto_continue',timestamp=103.2)
db.append_message('source','user',content='hidden scaffold',display_kind='hidden',timestamp=103.3)
db.append_message('source','user',content='same',timestamp=104)
db.append_message('source','assistant',content='next',timestamp=105)
db.close()`);
      const before = await native(
        "import json\nfrom hermes_state import SessionDB\ndb=SessionDB(read_only=True)\nprint(json.dumps(db.export_session('source'),sort_keys=True))\ndb.close()",
      );
      const snapshot = await history.readSnapshot();
      expect(snapshot.turns).toHaveLength(2);
      const projectionHistory = new HermesGatewayHistory({
        python,
        cwd: home,
        environment,
        nativeSessionId: "projection",
      });
      await projectionHistory.ensureCreated({ cwd: home });
      await native(`from hermes_state import SessionDB
db=SessionDB()
skill='[IMPORTANT: The user has invoked the "work" skill, indicating they want you to follow its instructions. The full skill content is loaded below.] Body The user has provided the following instruction alongside the skill invocation: fix bug'
db.append_message('projection','user',content=skill)
db.append_message('projection','assistant',content='done')
db.close()`);
      expect((await projectionHistory.readSnapshot()).turns[0]?.input).toEqual([
        { type: "text", text: "/work fix bug" },
      ]);
      const checkpoint = snapshot.turns[0]?.checkpoint;
      if (!checkpoint) throw new Error("Missing native checkpoint");
      const fork = await history.derive({ checkpoint });
      const forkHistory = new HermesGatewayHistory({
        python: python,
        cwd: home,
        environment,
        nativeSessionId: fork.nativeSessionId,
      });
      const forkSnapshot = await forkHistory.readSnapshot();
      expect(forkSnapshot.turns).toHaveLength(1);
      expect(forkSnapshot.turns[0]?.items.map((i) => i.item.type)).toEqual([
        "reasoning",
        "toolExecution",
        "agentMessage",
      ]);
      expect(forkSnapshot.turns[0]?.nativeTurnRef.nativeTurnKey).not.toEqual(
        snapshot.turns[0]?.nativeTurnRef.nativeTurnKey,
      );
      const rollback = await history.derive({ rollbackLastTurn: true });
      expect(
        (
          await new HermesGatewayHistory({
            python: python,
            cwd: home,
            environment,
            nativeSessionId: rollback.nativeSessionId,
          }).readSnapshot()
        ).turns,
      ).toHaveLength(1);
      const metadata = JSON.parse(
        await native(
          `import json\nfrom hermes_state import SessionDB\ndb=SessionDB(read_only=True)\nprint(json.dumps(db.get_session(${JSON.stringify(fork.nativeSessionId)})))\ndb.close()`,
        ),
      );
      expect(JSON.parse(metadata.model_config)).toMatchObject({
        yolo_mode: true,
        reasoning_effort: "high",
        _branched_from: "source",
      });
      const cleanup = await history.derive({ checkpoint });
      const stranger = new HermesGatewayHistory({
        python,
        cwd: home,
        environment,
        nativeSessionId: "source",
      });
      await expect(stranger.discardDerived(cleanup)).rejects.toMatchObject({
        code: "invalidRequest",
      });
      await expect(
        history.discardDerived({ ...cleanup, nativeSessionId: "source" }),
      ).rejects.toMatchObject({ code: "invalidRequest" });
      expect(await history.discardDerived(cleanup)).toBe(true);
      expect(
        await native(
          `import json\nfrom hermes_state import SessionDB\ndb=SessionDB(read_only=True)\nprint(json.dumps(db.get_session(${JSON.stringify(cleanup.nativeSessionId)})))\ndb.close()`,
        ),
      ).toBe("null");
      const changedChild = await history.derive({ checkpoint });
      await native(
        `from hermes_state import SessionDB\ndb=SessionDB()\ndb.append_message(${JSON.stringify(changedChild.nativeSessionId)},'user',content='changed after derivation')\ndb.close()`,
      );
      expect(await history.discardDerived(changedChild)).toBe(false);
      const after = await native(
        "import json\nfrom hermes_state import SessionDB\ndb=SessionDB(read_only=True)\nprint(json.dumps(db.export_session('source'),sort_keys=True))\ndb.close()",
      );
      expect(after).toBe(before);
      await expect(
        history.derive({ checkpoint: { ...checkpoint, locator: { count: 4, digest: "stale" } } }),
      ).rejects.toMatchObject({ code: "checkpointNotFound" });
      await native(
        "from hermes_state import SessionDB\ndb=SessionDB()\nrows=db.get_messages_as_conversation('source')\ndb.archive_and_compact('source',rows[-2:],tail_count=2)\ndb.close()",
      );
      const compacted = await history.readSnapshot();
      expect(compacted.turns.map((t) => t.nativeTurnRef.nativeTurnKey)).toEqual(
        snapshot.turns.map((t) => t.nativeTurnRef.nativeTurnKey),
      );
      expect(compacted.turns.every((t) => !t.checkpoint)).toBe(true);
      await expect(history.derive()).rejects.toMatchObject({ code: "unsupported" });
      // Native compression rotation keeps the public Thread identity while the
      // continuation's rows live under another persisted session id.
      await native(
        "from hermes_state import SessionDB\ndb=SessionDB()\nrows=db.get_messages_as_conversation('source')\ndb.end_session('source','compression')\ndb.create_session('compressed-child',source='cli',parent_session_id='source')\ndb.append_messages_batch('compressed-child',rows)\ndb.append_message('compressed-child','user',content='after rotation',timestamp=200)\ndb.append_message('compressed-child','assistant',content='rotated reply',timestamp=201)\ndb.close()",
      );
      expect(await history.resolvePhysicalSessionId()).toBe("compressed-child");
      const rotated = await history.readSnapshot();
      expect(rotated.turns.map((t) => t.nativeTurnRef.nativeSessionId)).toEqual([
        "source",
        "source",
        "source",
      ]);
      expect(rotated.turns.slice(0, 2).map((t) => t.nativeTurnRef.nativeTurnKey)).toEqual(
        snapshot.turns.map((t) => t.nativeTurnRef.nativeTurnKey),
      );
      expect(rotated.turns[2]?.input).toEqual([{ type: "text", text: "after rotation" }]);
      await expect(history.derive({ rollbackLastTurn: true })).rejects.toMatchObject({
        code: "unsupported",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);
});

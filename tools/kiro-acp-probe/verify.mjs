import assert from "node:assert/strict";
import { readFile, readdir, access, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// These are the evidence runs for the dated document, not a general conformance suite.
const runs = {
  v2Session: "2026-09-06T06-33-18-252Z-v2-session",
  v3Session: "2026-09-06T06-33-18-049Z-v3-session",
  firstTurn: "2026-09-06T06-35-55-727Z-v3-turn",
  secondTurn: "2026-09-06T06-37-50-525Z-v3-turn",
  modelFlag: "2026-09-06T06-40-44-954Z-v3-turn",
  fork: "2026-09-06T06-41-49-037Z-v3-rpc",
  edit: "2026-09-06T06-43-44-582Z-v3-turn",
  ordinaryQuestion: "2026-09-06T06-43-44-574Z-v3-turn",
  rewind: "2026-09-06T06-43-44-590Z-v3-rpc",
  question: "2026-09-06T06-48-06-397Z-v3-turn",
  compact: "2026-09-06T06-48-06-212Z-v3-turn",
  boundaries: "2026-09-06T06-48-06-401Z-v3-rpc",
  approvalCancel: "2026-09-06T06-49-01-984Z-v3-turn",
  subagent: "2026-09-06T06-49-01-989Z-v3-turn",
  continueAfterCancel: "2026-09-06T06-51-01-067Z-v3-turn",
  questionCancel: "2026-09-06T06-51-01-140Z-v3-turn",
  crossCwd: "2026-09-06T06-53-16-238Z-v3-turn",
  trustFlag: "2026-09-06T06-53-16-349Z-v3-inspect",
  emptyPrefix: "2026-09-06T06-53-16-324Z-v3-turn",
  help: "2026-09-06T06-55-20-333Z-v3-rpc",
  deny: "2026-09-06T06-55-20-409Z-v3-turn",
  configAndUsage: "2026-09-06T06-59-47-660Z-v3-session",
  rewindResume: "2026-09-06T07-03-28-898Z-v3-resume",
  compactResume: "2026-09-06T07-03-28-901Z-v3-resume",
};

const reports = Object.fromEntries(
  await Promise.all(
    Object.entries(runs).map(async ([name, runId]) => [
      name,
      JSON.parse(await readFile(path.resolve(".cache/kiro-acp-probe", `${runId}.json`), "utf8")),
    ]),
  ),
);
const results = [];
function check(name, verify, detail) {
  verify();
  results.push({ name, status: "PASS", detail });
}
function response(report, method) {
  return report.records.findLast(
    (entry) => entry.type === "response" && entry.data.method === method,
  )?.data.result;
}
function updates(report) {
  return report.records
    .filter((entry) => entry.type === "session.update")
    .map((entry) => entry.data.update);
}
function userIds(report) {
  return updates(report)
    .filter((update) => update.sessionUpdate === "user_message_chunk")
    .map((update) => update._meta?.kiro?.messageId);
}
function liveText(report) {
  return updates(report)
    .filter(
      (update) => update.sessionUpdate === "agent_message_chunk" && !update._meta?.kiro?.replay,
    )
    .map((update) => update.content.text)
    .join("");
}
function assignedId(report) {
  return updates(report).find((update) => update._meta?.kiro?.userMessageId)?._meta.kiro
    .userMessageId;
}
async function nativeSnapshot(sessionId) {
  assert.match(sessionId, /^sess_[a-f0-9-]+$/u);
  const root = path.join(os.homedir(), ".kiro", "sessions");
  const folders = await readdir(root, { withFileTypes: true });
  for (const entry of folders) {
    if (!entry.isDirectory() || entry.name === "cli") continue;
    const directory = path.join(root, entry.name, sessionId);
    try {
      await access(path.join(directory, "session.json"));
    } catch {
      continue;
    }
    const meta = JSON.parse(await readFile(path.join(directory, "session.json"), "utf8"));
    assert.equal(meta.id, sessionId);
    assert.ok(
      meta.workspacePaths.every((cwd) =>
        path.resolve(cwd).startsWith("D:\\DevTools\\kiro-acp-probe\\"),
      ),
      "Only read this probe's native histories",
    );
    const rows = (await readFile(path.join(directory, "messages.jsonl"), "utf8"))
      .split("\n")
      .filter((line) => line.trim())
      .map(JSON.parse);
    return {
      meta,
      rows,
      userIds: rows.filter((row) => row.payload.type === "user").map((row) => row.id),
    };
  }
  throw new Error(`Probe native session not found: ${sessionId}`);
}

const firstId = assignedId(reports.firstTurn);
check(
  "ACP initialization",
  () => {
    assert.equal(response(reports.v2Session, "initialize").agentInfo.version, "2.21.1");
    const v3 = response(reports.v3Session, "initialize");
    assert.equal(v3.protocolVersion, 1);
    assert.equal(v3.agentCapabilities.loadSession, true);
    assert.equal(v3.agentCapabilities.sessionCapabilities.fork._meta.kiro.messageId, true);
  },
  "Kiro CLI 2.21.1; both engines negotiate ACP 1; v3 advertises message-addressed Fork.",
);

check(
  "Streaming and cross-process identity",
  () => {
    assert.equal(liveText(reports.firstTurn), "ACK_COPPER_731");
    assert.equal(response(reports.firstTurn, "session/prompt").stopReason, "end_turn");
    assert.equal(userIds(reports.secondTurn)[0], firstId);
    assert.equal(reports.firstTurn.sessionId, reports.secondTurn.sessionId);
    assert.match(liveText(reports.secondTurn), /COPPER_731.*SECOND_OK/u);
  },
  "Native user message identity survives a new ACP process; context is retained.",
);

const editUpdates = updates(reports.edit);
const terminalEdit = editUpdates.findLast(
  (update) =>
    update.status === "completed" && update.content?.some((content) => content.type === "diff"),
);
const editFile = await readFile(path.join(reports.edit.cwd, "sample.txt"), "utf8");
check(
  "Edit, Diff and two-stage approval",
  () => {
    const diff = terminalEdit.content.find((content) => content.type === "diff");
    assert.equal(diff.oldText, "alpha\n");
    assert.equal(diff.newText, "beta\n");
    assert.match(diff.path, /^file:/u);
    assert.equal(editFile, "beta\n");
    const approvals = reports.edit.records.filter((entry) => entry.type === "permission.request");
    assert.equal(approvals.length, 2);
    assert.equal(approvals[1].data._meta.kiro.type, "turn_approval");
  },
  "Successful terminal Diff matches the actual file; consent and final review are separate.",
);

const deniedFile = await readFile(path.join(reports.deny.cwd, "sample.txt"), "utf8");
check(
  "Denial and Autopilot boundary",
  () => {
    assert.equal(deniedFile, "alpha\n");
    assert.ok(
      reports.deny.records.some(
        (entry) => entry.type === "permission.response" && entry.data.outcome.optionId === "reject",
      ),
    );
    const autopilot = response(reports.deny, "session/new").configOptions.find(
      (option) => option.id === "autopilot",
    );
    assert.equal(autopilot.currentValue, "on");
  },
  "Autopilot on still requested filesystem consent; denial prevented the edit.",
);

check(
  "Cancel and continuation",
  () => {
    assert.equal(response(reports.approvalCancel, "session/prompt").stopReason, "cancelled");
    assert.equal(liveText(reports.continueAfterCancel), "CANCEL_CONTINUE_OK");
    assert.equal(editFile, "beta\n");
  },
  "Cancellation while waiting for approval returns cancelled; a later process can continue.",
);

check(
  "Question answer and cancellation",
  () => {
    const question = reports.question.records.find((entry) => entry.type === "extension.request");
    assert.equal(question.data.method, "_kiro/userInput");
    assert.equal(question.data.params.options.length, 2);
    assert.ok(
      reports.question.records.some(
        (entry) => entry.type === "extension.response" && entry.data.result.action === "answered",
      ),
    );
    assert.equal(response(reports.questionCancel, "session/prompt").stopReason, "cancelled");
    assert.ok(
      !reports.ordinaryQuestion.records.some((entry) => entry.type === "extension.request"),
    );
  },
  "Spec-mode Question works with advertised client capabilities; ordinary-mode probe did not trigger it.",
);

const source = await nativeSnapshot(reports.firstTurn.sessionId);
const fork = await nativeSnapshot(response(reports.fork, "session/fork").sessionId);
check(
  "Exact Fork, source isolation and continued write",
  () => {
    assert.equal(source.userIds.length, 2);
    assert.deepEqual(userIds(reports.compact), [firstId]);
    assert.equal(fork.userIds[0], firstId);
    assert.equal(fork.userIds.length, 2);
    assert.notEqual(fork.userIds[1], source.userIds[1]);
    assert.match(liveText(reports.compact), /COPPER_731.*FORK_CONTINUE_OK/u);
    assert.equal(fork.meta.modelId, "claude-haiku-4.5");
    assert.equal(fork.meta.autopilot, false);
  },
  "One source Turn was retained before the child's continuation; configuration was explicitly restored.",
);

check(
  "Compaction and historical identities",
  () => {
    assert.equal(response(reports.compact, "_kiro/session/compact").success, true);
    assert.ok(
      updates(reports.compact).some(
        (update) =>
          update._meta?.kiro?.kind === "summarization_completed" &&
          update._meta.kiro.summarization.status === "success",
      ),
    );
    assert.deepEqual(userIds(reports.compactResume), fork.userIds);
    assert.ok(
      fork.rows.some(
        (row) => row.payload.type === "tombstone" && row.payload.kind === "summarization",
      ),
    );
  },
  "Native summarization completed; reload retained both historical user identities.",
);

const empty = await nativeSnapshot(reports.emptyPrefix.sessionId);
check(
  "Empty-prefix Fork remains writable",
  () => {
    assert.deepEqual(userIds(reports.emptyPrefix), []);
    assert.equal(empty.userIds.length, 1);
    assert.equal(liveText(reports.emptyPrefix), "EMPTY_PREFIX_CONTINUE_OK");
  },
  "A native bootstrap boundary produced zero user Turns before a successful new Turn.",
);

const cross = await nativeSnapshot(reports.crossCwd.sessionId);
check(
  "Cross-cwd Fork and environment propagation",
  () => {
    assert.equal(cross.meta.workspacePaths[0], reports.crossCwd.cwd);
    assert.notEqual(reports.crossCwd.cwd, reports.firstTurn.cwd);
    const command = updates(reports.crossCwd).findLast(
      (update) => update.rawOutput?.exitCode === 0,
    );
    assert.ok(command.rawOutput.output.includes(reports.crossCwd.cwd));
    assert.ok(command.rawOutput.output.includes(reports.crossCwd.runId));
  },
  "The native shell reported the destination cwd and this run's harmless environment marker.",
);

check(
  "Native subagent observation",
  () => {
    const child = updates(reports.subagent).find(
      (update) => update._meta?.kiro?.kind === "agent-subtask" && update.status === "completed",
    );
    assert.ok(child._meta.kiro.agentSubtaskId);
    assert.equal(child.rawOutput, "CHILD_OK");
  },
  "A real native subtask has a stable observed ID and a successful result; transcript reads were not tested.",
);

check(
  "Configuration and account usage distinctions",
  () => {
    const options = response(reports.configAndUsage, "session/set_config_option").configOptions;
    assert.ok(!options.some((option) => option.id === "effortLevel"));
    assert.ok(!Object.hasOwn(source.meta, "effortLevel"));
    assert.equal(response(reports.configAndUsage, "_kiro/account/getUsage").success, true);
    assert.ok(response(reports.configAndUsage, "session/list").sessions.length > 0);
  },
  "Effort write returned without a confirmed effective value; native account usage and session listing work.",
);

check(
  "Negative protocol findings",
  () => {
    for (const [name, flag] of [
      ["modelFlag", "--model"],
      ["trustFlag", "--trust-all-tools"],
    ]) {
      assert.ok(
        reports[name].records.some(
          (entry) =>
            entry.type === "stderr" &&
            entry.data.includes("not supported") &&
            entry.data.includes(flag),
        ),
      );
    }
    assert.ok(
      reports.help.records.some(
        (entry) =>
          entry.type === "rpc.error" &&
          entry.data.data.details.includes("persistence classification"),
      ),
    );
    assert.ok(
      reports.boundaries.records.some(
        (entry) => entry.type === "rpc.error" && entry.data.data.details.includes("not found"),
      ),
    );
    assert.equal(userIds(reports.rewindResume).length, 2);
  },
  "Rejected v3 flags, broken help, invalid checkpoint rejection, and non-rollback rewind response are preserved.",
);

const evidence = {
  schemaVersion: 1,
  verifiedAt: new Date().toISOString(),
  baseline: {
    cliVersion: "2.21.1",
    kasVersion: "0.58.7",
    protocolVersion: 1,
    nodeVersion: process.version,
    platform: process.platform,
    repositoryCommit: "443271cfec6e0fefc6a3d54607e9fd0871456bc0",
    realModels: ["claude-haiku-4.5"],
  },
  boundaries: {
    adapterImplemented: false,
    desktopE2eRun: false,
    fullCrossHarnessDelegationRun: false,
    rawReportsAreLocalIgnoredArtifacts: true,
    existingUserSessionsRead: false,
    paidPromptProbesOccurred: true,
    taskCostUsd: null,
  },
  results,
  runs,
};
const output = path.resolve("docs/kiro-cli-acp-evidence.json");
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ checks: results.length, status: "PASS", output }, null, 2));

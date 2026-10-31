import { createInterface } from "node:readline";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

if (process.argv.includes("--version")) {
  console.log("traecli 0.213.1");
  process.exit(0);
}

// Captured 0.213.1 wire shapes; no authentication, remote requests or native CLI required.
const store = process.env.TRAE_TEST_STORE;
const log = process.env.TRAE_TEST_LOG;
const mode = process.env.TRAE_TEST_MODE;
const threads = new Map();
const replies = new Map();
let active;
function save() {
  writeFileSync(store, JSON.stringify(Object.fromEntries(threads)));
}
try {
  for (const [k, v] of Object.entries(JSON.parse(readFileSync(store, "utf8")))) threads.set(k, v);
} catch {
  /* first invocation */
}
function send(frame) {
  process.stdout.write(JSON.stringify(frame) + "\n");
}
function event(method, params) {
  send({ method, params });
}
function response(id, result) {
  send({ id, result });
}
function state(id) {
  const t = threads.get(id);
  return {
    thread: { id, cwd: t.cwd, turns: t.turns },
    cwd: t.cwd,
    model: t.model,
    modelProvider: "trae",
    reasoningEffort: t.effort ?? null,
    approvalPolicy: t.approvalPolicy ?? "on-request",
    sandbox: {
      type:
        t.sandbox === "danger-full-access"
          ? "dangerFullAccess"
          : t.sandbox === "read-only"
            ? "readOnly"
            : "workspaceWrite",
    },
  };
}
function overrides(t, p) {
  for (const k of ["cwd", "model", "approvalPolicy", "sandbox"]) if (p[k]) t[k] = p[k];
  if (p.config?.model_reasoning_effort) t.effort = p.config.model_reasoning_effort;
}
function complete(status = "completed") {
  if (!active) return;
  const { threadId, turn, prompt } = active;
  if (status === "completed") {
    const answer = {
      id: "answer-" + turn.id,
      type: "agentMessage",
      text: "Hello 世界",
      phase: "final_answer",
    };
    turn.items.push(answer);
    event("item/started", { threadId, turnId: turn.id, item: { ...answer, text: "" } });
    event("item/agentMessage/delta", {
      threadId,
      turnId: turn.id,
      itemId: answer.id,
      delta: "Hello 世界",
    });
    event("item/completed", { threadId, turnId: turn.id, item: answer });
  }
  turn.status = status;
  save();
  event("thread/tokenUsage/updated", {
    threadId,
    turnId: turn.id,
    tokenUsage: {
      total: { inputTokens: 8, cachedInputTokens: 2, outputTokens: 3, totalTokens: 11 },
      last: { totalTokens: 11 },
      modelContextWindow: 128000,
    },
  });
  event("turn/completed", { threadId, turn });
  if (prompt === "duplicates") event("turn/completed", { threadId, turn });
  active = undefined;
}
async function handle(f) {
  if (!f.method) {
    const resume = replies.get(f.id);
    replies.delete(f.id);
    resume?.(f);
    return;
  }
  appendFileSync(
    log,
    JSON.stringify({
      method: f.method,
      params: f.params,
      cwd: process.cwd(),
      marker: process.env.TRAE_TEST_MARKER,
    }) + "\n",
  );
  const p = f.params ?? {};
  if (f.method === "initialize") {
    if (mode === "hang-handshake") return;
    return response(f.id, { userAgent: "Trae/0.213.1 fixture" });
  }
  if (f.method === "initialized") return;
  if (f.method === "account/read")
    return response(f.id, {
      account: mode === "unauthenticated" ? null : { type: "trae" },
      requiresOpenaiAuth: true,
    });
  if (f.method === "model/list") {
    if (mode === "malformed") {
      process.stdout.write("not-json\n");
      return;
    }
    return response(f.id, {
      data:
        mode === "empty"
          ? []
          : [
              {
                id: "model-a",
                model: "model-a",
                displayName: "Model A",
                modelProviderId: "trae",
                hidden: false,
                isDefault: true,
                supportedReasoningEfforts: [
                  { reasoningEffort: "low", description: "Low" },
                  { reasoningEffort: "high", description: "High" },
                ],
              },
              {
                id: "b",
                model: "model-b",
                displayName: "Model B",
                modelProviderId: "trae",
                supportedReasoningEfforts: [],
              },
              { model: "hidden", hidden: true },
            ],
      nextCursor: null,
    });
  }
  if (f.method === "thread/start") {
    const id = randomUUID();
    const t = { cwd: p.cwd, model: "model-a", turns: [] };
    overrides(t, p);
    if (mode === "ignore-model") t.model = "model-a";
    if (mode === "ignore-permission") delete t.sandbox;
    threads.set(id, t);
    save();
    return response(f.id, state(id));
  }
  if (
    ["thread/resume", "thread/read", "thread/fork", "thread/rollback"].includes(f.method) &&
    !threads.has(p.threadId)
  )
    return send({ id: f.id, error: { code: -32000, message: "Thread not found" } });
  if (f.method === "thread/resume") {
    const t = threads.get(p.threadId);
    overrides(t, p);
    save();
    return response(f.id, state(p.threadId));
  }
  if (f.method === "thread/read")
    return response(f.id, { thread: { id: p.threadId, turns: threads.get(p.threadId).turns } });
  if (f.method === "thread/fork") {
    const id = randomUUID();
    const t = structuredClone(threads.get(p.threadId));
    overrides(t, p);
    if (p.lastTurnId && mode !== "bad-fork")
      t.turns = t.turns.slice(0, t.turns.findIndex((t) => t.id === p.lastTurnId) + 1);
    threads.set(id, t);
    save();
    return response(f.id, state(id));
  }
  if (f.method === "thread/rollback") {
    const t = threads.get(p.threadId);
    t.turns.splice(-p.numTurns);
    save();
    return response(f.id, { thread: { id: p.threadId, turns: t.turns } });
  }
  if (f.method === "turn/start") {
    const prompt = p.input.map((i) => i.text).join("");
    if (prompt === "model-missing")
      return send({
        id: f.id,
        error: { code: -32000, message: "Model not found; secret-token-never-echo" },
      });
    if (prompt === "reject")
      return send({
        id: f.id,
        error: { code: -32602, message: "fixture rejected; secret-token-never-echo" },
      });
    if (prompt === "exit") {
      process.exit(1);
    }
    const turn = {
      id: randomUUID(),
      status: "inProgress",
      itemsView: "full",
      items: [{ id: randomUUID(), type: "userMessage", content: p.input }],
    };
    threads.get(p.threadId).turns.push(turn);
    save();
    active = { turn, threadId: p.threadId, prompt };
    event("turn/started", { threadId: p.threadId, turn }); // intentionally before acceptance reply
    response(f.id, { turn });
    if (prompt === "hang") return;
    if (prompt === "autonomous") {
      complete();
      setTimeout(() => {
        const next = { id: randomUUID(), status: "inProgress", itemsView: "full", items: [] };
        threads.get(p.threadId).turns.push(next);
        active = { threadId: p.threadId, turn: next, prompt: "native autonomous" };
        event("turn/started", { threadId: p.threadId, turn: next });
        complete();
      }, 30);
      return;
    }
    if (prompt === "crash") {
      setTimeout(() => process.exit(1), 30);
      return;
    }
    if (prompt === "approval" || prompt === "question") {
      const id = "request-" + turn.id;
      replies.set(id, () => complete());
      send({
        id,
        method:
          prompt === "approval"
            ? "item/commandExecution/requestApproval"
            : "item/tool/requestUserInput",
        params: {
          threadId: p.threadId,
          turnId: turn.id,
          itemId: "tool-1",
          command: "echo test",
          questions: [
            {
              id: "q1",
              question: "Choose",
              options: [{ label: "A", description: "one" }],
              multiSelect: false,
              isOther: false,
            },
          ],
        },
      });
      return;
    }
    setTimeout(() => complete(), 15);
    return;
  }
  if (f.method === "turn/interrupt") {
    response(f.id, {});
    // An acknowledgment is not a terminal event.
    setTimeout(() => complete("interrupted"), 80);
    return;
  }
  send({ id: f.id, error: { code: -32601, message: "unknown method" } });
}
createInterface({ input: process.stdin }).on("line", (line) => {
  void handle(JSON.parse(line));
});

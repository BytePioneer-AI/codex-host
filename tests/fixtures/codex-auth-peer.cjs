/** Synthetic Codex native local credentials and Thread protocol; no login or network. */
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
if (process.argv.includes("--version")) process.exit(0);
const home = process.env.CODEX_HOME;
const file = (name) => path.join(home, name);
fs.mkdirSync(home, { recursive: true });
const read = (name, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file(name), "utf8"));
  } catch {
    return fallback;
  }
};
const write = (name, value) => fs.writeFileSync(file(name), JSON.stringify(value));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const notify = (method, params) => send({ method, params });
let turn = 0;
let threadId = "";
let nextServerRequest = 0;
const serverRequests = new Map();
const pendingTurns = new Set();

/** Ask the client a request and resolve with its response. */
function serverRequest(method, params) {
  const id = `srv-${process.pid}-${++nextServerRequest}`;
  return new Promise((resolve) => {
    serverRequests.set(id, resolve);
    send({ id, method, params });
  });
}

function completeTurn(id, status, error) {
  const item = { id: "answer-" + id, type: "agentMessage", text: "Response " + id };
  const cancelled = status === "interrupted";
  if (!cancelled && !error) {
    notify("item/started", { threadId, turnId: id, item: { ...item, text: "" } });
    notify("item/agentMessage/delta", {
      threadId,
      turnId: id,
      itemId: item.id,
      delta: item.text,
    });
    notify("item/completed", { threadId, turnId: id, item });
  }
  const value = {
    id,
    status,
    error: error ?? null,
    items: error || cancelled ? [] : [item],
    startedAt: 1,
    completedAt: 2,
  };
  write("turns.json", [...read("turns.json", []), value]);
  notify("turn/completed", { threadId, turnId: id, turn: value });
}

async function runTurn(id, text, config) {
  await new Promise((resolve) => setTimeout(resolve, config.turnDelay ?? 80));
  if (!pendingTurns.has(id)) return;
  if (config.approval) {
    await serverRequest("item/commandExecution/requestApproval", {
      threadId,
      turnId: id,
      itemId: `command-${id}`,
      command: "ls",
      reason: "Synthetic approval",
    });
    if (!pendingTurns.has(id)) return;
  }
  if (config.question) {
    await serverRequest("item/tool/requestUserInput", {
      threadId,
      turnId: id,
      questions: [
        {
          id: "question-1",
          header: "Synthetic question",
          question: "Continue?",
          isOther: false,
          isSecret: false,
          options: null,
        },
      ],
    });
    if (!pendingTurns.has(id)) return;
  }
  pendingTurns.delete(id);
  const failed =
    text.includes("reject-auth") || (config.requireAuth && !read("authenticated.json", false));
  completeTurn(
    id,
    failed ? "failed" : "completed",
    failed ? { message: "Native model unauthorized", codexErrorInfo: "unauthorized" } : null,
  );
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === undefined) {
    // A response to one of our own server requests.
    const resolve = serverRequests.get(request.id);
    if (resolve) {
      serverRequests.delete(request.id);
      resolve(request);
    }
    return;
  }
  fs.appendFileSync(
    file("rpc.jsonl"),
    JSON.stringify({
      method: request.method,
      pid: process.pid,
      params: request.params,
      env: {
        CODEX_HOME: process.env.CODEX_HOME,
        CODEX_CLI_PATH: process.env.CODEX_CLI_PATH,
        CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
        NODE_OPTIONS: process.env.NODE_OPTIONS,
        NODE_PATH: process.env.NODE_PATH,
        codexhostKeys: Object.keys(process.env).filter((key) => key.startsWith("CODEXHOST_")),
      },
    }) + "\n",
  );
  if (request.id === undefined) return;
  const config = read("scenario.json", {});
  let result = {};
  if (request.method === "account/read")
    result = config.accountRead ?? { account: null, requiresOpenaiAuth: true };
  if (request.method === "account/rateLimits/read") {
    if (config.quotaError) {
      send({ id: request.id, error: { code: -32000, message: "Native quota unavailable" } });
      return;
    }
    result = config.rateLimits ?? { rateLimits: null };
  }
  if (request.method === "model/list")
    result = {
      data: [
        {
          id: "test-model",
          displayName: "Test",
          description: "",
          hidden: false,
          isDefault: true,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: "medium",
        },
      ],
    };
  const waitFile =
    request.method === "model/list"
      ? config.modelWaitFile
      : request.method === "account/rateLimits/read"
        ? config.quotaWaitFile
        : undefined;
  if (waitFile) {
    const waiting = setInterval(() => {
      if (!fs.existsSync(file(waitFile))) return;
      clearInterval(waiting);
      send({ id: request.id, result });
    }, 10);
    return;
  }
  if (request.method === "thread/start" || request.method === "thread/resume") {
    threadId =
      request.method === "thread/start" ? `native-${process.pid}` : request.params.threadId;
    result = { thread: { id: threadId }, model: "test-model", reasoningEffort: null };
  }
  if (request.method === "turn/steer" && config.steerReject) {
    send({
      id: request.id,
      error: {
        code: -32000,
        message: "cannot steer",
        ...(config.steerUnauthorized ? { data: { codexErrorInfo: "unauthorized" } } : {}),
      },
    });
    return;
  }
  if (request.method === "thread/read")
    result = { thread: { turns: config.unsavedTurns === true ? [] : read("turns.json", []) } };
  if (request.method === "thread/list") result = { data: config.threads ?? [] };
  if (request.method === "turn/start") {
    const id = "turn-" + process.pid + "-" + ++turn;
    const text = request.params.input.map((part) => part.text ?? "").join("");
    pendingTurns.add(id);
    send({ id: request.id, result: { turn: { id } } });
    notify("turn/started", { threadId, turn: { id } });
    void runTurn(id, text, config);
    return;
  }
  if (request.method === "turn/interrupt") {
    const id = request.params.turnId;
    send({ id: request.id, result });
    if (pendingTurns.delete(id)) completeTurn(id, "interrupted", null);
    return;
  }
  send({ id: request.id, result });
});

const PRINT_BUILTINS = /^(echo|printf|print)$/iu;
const CLI_INVOCATION = /^(?:\$CODEXHOST_CLI_PATH|codexhost)$/iu;
const BLOCKED_THREAD_STATUS = new Set([
  "failed",
  "error",
  "timedOut",
  "running",
  "unavailable",
  "creating",
  "interrupted",
  "pending",
]);

export function tokenizeShellWords(command) {
  const text = String(command ?? "");
  const tokens = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "#" && (current.length === 0 || /\s/u.test(text[index - 1] ?? " "))) break;
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    if (character === "\\") return null;
    current += character;
  }
  if (quote) return null;
  if (current) tokens.push(current);
  return tokens;
}

function normalizeThreadId(value) {
  const prefix = "codex://threads/";
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function parseOptions(tokens) {
  const positionals = [];
  const options = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const value = tokens[index + 1];
    if (!value || value.startsWith("--")) return null;
    options.set(token, value);
    index += 1;
  }
  return { positionals, options };
}

function isCliInvocation(token) {
  if (CLI_INVOCATION.test(token)) return true;
  return /(?:^|[/\\])(?:codexhost(?:\.mjs)?|cli-wrapper\.mjs)$/iu.test(token);
}

export function parseChildThreadCliInvocation(command, childThreadId) {
  const tokens = tokenizeShellWords(command);
  if (tokens === null) return { action: null, unsupported: true };
  if (tokens.length === 0) return { action: null, unsupported: false };
  let offset = 0;
  while (offset < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[offset])) offset += 1;
  const argv = tokens.slice(offset);
  if (argv.length === 0) return { action: null, unsupported: false };
  if (PRINT_BUILTINS.test(argv[0]) || argv[0].startsWith("#")) {
    return { action: null, unsupported: false };
  }
  if (!isCliInvocation(argv[0])) return { action: null, unsupported: true };
  if (argv[1] !== "thread" || (argv[2] !== "send" && argv[2] !== "wait")) {
    return { action: null, unsupported: false };
  }
  const parsed = parseOptions(argv.slice(3));
  if (!parsed || parsed.positionals.length !== 1) {
    return { action: null, unsupported: true };
  }
  if (normalizeThreadId(parsed.positionals[0]) !== childThreadId) {
    return { action: null, unsupported: false };
  }
  if (argv[2] === "wait") {
    for (const name of parsed.options.keys()) {
      if (!["--timeout-ms", "--view", "--cursor", "--limit"].includes(name)) {
        return { action: null, unsupported: true };
      }
    }
    return { action: "wait", unsupported: false };
  }
  if (!parsed.options.has("--message") && !parsed.options.has("--message-file")) {
    return { action: null, unsupported: true };
  }
  for (const name of parsed.options.keys()) {
    if (!["--message", "--message-file", "--request-id", "--expected-turn"].includes(name)) {
      return { action: null, unsupported: true };
    }
  }
  return { action: "send", unsupported: false };
}

export function commandUsesChildThreadCli(command, childThreadId) {
  return parseChildThreadCliInvocation(command, childThreadId).action !== null;
}

export function parseCliJsonStdout(cli) {
  const text = String(cli?.stdout ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function canonicalReviewText(snapshot) {
  if (snapshot?.result?.availability !== "available") return "";
  return typeof snapshot.result.text === "string" ? snapshot.result.text : "";
}

export function reviewMentionsPlant(text, leakToken) {
  if (typeof text !== "string" || !text) return false;
  if (leakToken && text.includes(leakToken)) return true;
  return /(?:^|[^A-Za-z0-9_])leak\.py(?:[^A-Za-z0-9_]|$)/u.test(text);
}

export function requireSuccessfulThreadOutcome(cli, label, options = {}) {
  if (cli.status !== 0 || cli.error) {
    throw new Error(
      `${label} CLI failed: ${cli.error ?? ""} ${cli.stderr || cli.stdout}`.trim(),
    );
  }
  const body = parseCliJsonStdout(cli);
  if (!body) throw new Error(`${label} stdout was not JSON`);
  if (body.error) {
    throw new Error(
      `${label} returned ${body.error.code ?? "error"}: ${body.error.message ?? ""}`.trim(),
    );
  }
  if (body.timedOut === true) throw new Error(`${label} timed out`);
  if (body.status !== "completed" || BLOCKED_THREAD_STATUS.has(body.status)) {
    throw new Error(`${label} status ${String(body.status)} is not a successful terminal`);
  }
  if (options.requireAvailableResult) {
    const text = canonicalReviewText(body);
    if (!text.trim()) {
      throw new Error(`${label} has no canonical available result.text`);
    }
  } else if (body.result?.availability === "unavailable" || body.result?.availability === "pending") {
    throw new Error(`${label} result ${body.result.availability} is not a successful terminal`);
  }
  return body;
}

export function completedChildCliEvidence(item, childThreadId) {
  if (item?.kind !== "command") return { action: null, unsupported: false };
  if (item.completed !== true || item.exitCode !== 0) {
    return { action: null, unsupported: false };
  }
  return parseChildThreadCliInvocation(item.command, childThreadId);
}

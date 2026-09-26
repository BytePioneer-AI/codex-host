const COMMAND_HELP = {
  "harness list": `codexhost harness list [--format json|compact]
List Harnesses available in the active Runtime.`,
  "harness inspect": `codexhost harness inspect <harness> [--cwd <path>] [--refresh true|false] [--format json|compact]
Read available Models, native defaults, Thinking options, and configuration capabilities.
Use the returned Model and Thinking IDs for explicit selections.`,
  "delegate start": `codexhost delegate start --harness <id> --task <text> [--cwd <path>] [--model <opaque-ref>] [--thinking <option-id>] [--parent-thread <thread>] [--request-id <id>] [--watch true|false] [--watch-timeout-ms <n>] [--format json|compact]
Create an independent child Thread, submit the task, and return immediately.
Omit --model and --thinking to use the Harness native defaults.
--cwd overrides the child workspace. Otherwise use the resolved parent Thread workspace, then the Host Runtime process cwd.
--parent-thread overrides caller inference. PARENT_THREAD_AMBIGUOUS requires an explicit parent.
Reuse --request-id for an idempotent retry. Identical recent parent/target/task/configuration requests are also deduplicated briefly.
--watch true also registers thread watch on the child with the resolved parent as the notified Thread; the response's watch field reports whether it was registered.
The response confirms cwd and parent. Use its Thread reference with thread read, wait, send, cancel, or watch.`,
  "thread send": `codexhost thread send <thread> --message <text> [--watch true|false] [--watch-timeout-ms <n>] [--notify <thread>] [--format json|compact]
Start a new Turn in an idle writable Thread and return immediately.
THREAD_BUSY means the current Turn is still active: wait or cancel before sending. Messages are not queued.
--watch true also registers thread watch until that Thread stops; the response's watch field reports whether it was registered. See thread watch --help for --notify and the notification.`,
  "thread cancel": `codexhost thread cancel <thread> [--format json|compact]
Request cancellation of the active Turn while preserving the Thread and history.
cancelled=true (compact: cancelRequested=true) means the cancellation request was accepted. Read or wait to confirm the terminal state. An idle Thread returns false.`,
  "thread read": `codexhost thread read <thread> [--view result|messages] [--cursor <cursor>] [--limit <n>] [--format json|compact]
Read immediately without starting a Turn. The default result view reports the latest Turn's status and result.
The messages view pages visible user/Agent messages, oldest first. Default limit 25, maximum 100; --cursor and --limit require --view messages.
hasMore describes remaining messages now. Save nextCursor for later incremental reads even when hasMore=false.
Compact messages output contains only the message page and status; compact result output includes the latest nonempty progress while running.
Full JSON retains the complete snapshot. Tool calls/output, file activity, and reasoning are not included in either format.`,
  "thread wait": `codexhost thread wait <thread> [--timeout-ms <n>] [--view result|messages] [--cursor <cursor>] [--limit <n>] [--format json|compact]
Wait until the Thread is terminal or the timeout expires (default 30000 ms), then return the same snapshot as thread read plus timedOut.
timedOut=true is a running checkpoint: the child keeps running. The response already includes the result when available; another read is unnecessary unless more information is needed.
Message pagination uses --view messages, default limit 25, maximum 100. hasMore is for current pages; nextCursor also supports future incremental reads.`,
  "thread watch": `codexhost thread watch <thread> [--notify <thread>] [--timeout-ms <n>] [--format json|compact]
Ask the Host to notify one Thread, once, when the watched Thread stops. Returns immediately; no waiting or polling by the caller is needed, and the caller may end its Turn.
--notify defaults to the calling Thread. A caller the Host cannot identify directly (native Codex) is inferred as the only other Thread with an active Turn; PARENT_THREAD_AMBIGUOUS requires an explicit --notify (delegate start reports the caller as its parent).
The notification starts a new Turn in the notified Thread with the watched Thread's link and outcome: completed, failed, interrupted, timedOut, unreadable, or notFound. It reports execution state only; read the Thread to judge the work.
--timeout-ms defaults to 1740000 (29 min). timedOut means the Thread had not reached a terminal state, which also covers a Harness that stopped without reporting it; watch again to keep waiting. unreadable means reads failed for 60 s, so the state is unknown.
state=watching means registered. state=alreadyTerminal means the Thread was not running: nothing was registered and nothing will be sent.
A busy notified Thread is notified after its Turn ends (retried for up to 6 hours); notifications due together arrive as one message. THREAD_BUSY is never treated as delivered.
A watch is one-shot and cannot be cancelled. Watches live in Host Runtime memory and are lost when it restarts.`,
  "thread watches": `codexhost thread watches [--format json|compact]
List watches that have not been delivered: watching, pendingDelivery (waiting for the notified Thread), or undeliverable (with the reason). Delivered watches are removed.`,
  "thread list": `codexhost thread list [--cwd <path>] [--parent <thread>] [--limit <n>] [--cursor <cursor>] [--sort created-asc|created-desc|updated-asc|updated-desc|recency-asc|recency-desc] [--format json|compact]
Find existing Threads by workspace, or use --parent to list a Thread's delegated children.
Workspace listing defaults to the caller process cwd. Default limit 25 (maximum 100), sorted created-desc.
--parent uses Delegation relationships. A null nextCursor ends the list.
Compact output keeps task links, Harness, status, title, and workspace.`,
} as const;

export type DelegationCliCommand = keyof typeof COMMAND_HELP;

const COMMON_HELP = `Thread references accept a bare ID or codex://threads/<id>.
--format json is the compatible full JSON output (default); --format compact returns concise JSON using task links instead of internal IDs.
Success is written to stdout; errors {"error":{"code":"...","message":"...","details":{...}}} go to stderr with exit code 1. Exit code 0 means the command succeeded, not that the delegated task succeeded.
read/wait are non-consuming. Native Codex callers need local Runtime access; RUNTIME_UNREACHABLE requires the Host-provided environment and a sandbox that permits that connection.
Native Codex shell commands also need the Host-provided CODEXHOST_* environment variables. If shell_environment_policy filters them, prefer inherit = "all" with ignore_default_excludes = true and a narrow include_only containing "CODEXHOST_RUNTIME_ENDPOINT" and "CODEXHOST_RUNTIME_TOKEN" plus the variables required by the platform and invoked tools. Avoid unconstrained inherit = "all", which forwards unrelated ambient variables.`;

export const DELEGATION_HELP = `usage:
  codexhost harness list
  codexhost harness inspect <harness>
  codexhost delegate start --harness <id> --task <text>
  codexhost thread send <thread> --message <text>
  codexhost thread cancel <thread>
  codexhost thread read <thread>
  codexhost thread wait <thread>
  codexhost thread watch <thread>
  codexhost thread watches
  codexhost thread list

Use <command> --help for its options. Use harness list to discover targets.
${COMMON_HELP}
`;

function hasHelpOption(arguments_: readonly string[]): boolean {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") return true;
    if (argument?.startsWith("--")) index += 1;
  }
  return false;
}

export function delegationCliHelp(arguments_: readonly string[]): string | undefined {
  const [group, command, ...rest] = arguments_;
  if (!group || group === "--help" || group === "-h") return DELEGATION_HELP;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    if (group === "delegate") return DELEGATION_HELP;
    if (group === "harness" || group === "thread") {
      const usages = Object.entries(COMMAND_HELP)
        .filter(([name]) => name.startsWith(`${group} `))
        .map(([, help]) => help.split("\n")[0]);
      return `${usages.join("\n")}\n\n${COMMON_HELP}\n`;
    }
  }
  if (hasHelpOption(rest)) {
    const name = `${group} ${command}`;
    if (Object.hasOwn(COMMAND_HELP, name)) {
      return `${COMMAND_HELP[name as DelegationCliCommand]}\n\n${COMMON_HELP}\n`;
    }
  }
  return undefined;
}

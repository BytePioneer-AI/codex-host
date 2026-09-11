const COMMAND_HELP = {
  "harness list": `codexhost harness list [--format json|compact]
List Harnesses available in the active Runtime.`,
  "harness inspect": `codexhost harness inspect <harness> [--cwd <path>] [--refresh true|false] [--format json|compact]
Read available Models, native defaults, Thinking options, and configuration capabilities.
Use the returned Model and Thinking IDs for explicit selections.`,
  "delegate start": `codexhost delegate start --harness <id> --task <text> [--cwd <path>] [--model <opaque-ref>] [--thinking <option-id>] [--parent-thread <thread>] [--request-id <id>] [--format json|compact]
Create an independent child Thread, submit the task, and return immediately.
Omit --model and --thinking to use the Harness native defaults.
--cwd overrides the child workspace. Otherwise use the resolved parent Thread workspace, then the Host Runtime process cwd.
--parent-thread overrides caller inference. PARENT_THREAD_AMBIGUOUS requires an explicit parent.
Reuse --request-id for an idempotent retry. Identical recent parent/target/task/configuration requests are also deduplicated briefly.
The response confirms cwd and parent. Use its Thread reference with thread read, wait, send, or cancel.`,
  "thread send": `codexhost thread send <thread> --message <text> [--format json|compact]
Start a new Turn in an idle writable Thread and return immediately.
THREAD_BUSY means the current Turn is still active: wait or cancel before sending. Messages are not queued.`,
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
read/wait are non-consuming. Native Codex callers need local Runtime access; RUNTIME_UNREACHABLE requires the Host-provided environment and a sandbox that permits that connection.`;

export const DELEGATION_HELP = `usage:
  codexhost harness list
  codexhost harness inspect <harness>
  codexhost delegate start --harness <id> --task <text>
  codexhost thread send <thread> --message <text>
  codexhost thread cancel <thread>
  codexhost thread read <thread>
  codexhost thread wait <thread>
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

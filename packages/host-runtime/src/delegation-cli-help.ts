import { consumesNextArgument } from "./delegation-cli-options.js";

const MESSAGE_VIEW_HELP = `The messages view returns Turns newest first, with user messages before each Turn's final Agent reply. Intermediate commentary is omitted; terminal Turns without a final marker use their last nonempty Agent message. Running Turns contain only user input. Each Turn includes turnNumber and status, even without messages.
--from and --to are inclusive absolute Turn numbers, starting at 1, and require --view messages. Neither: latest 10 Turns. Only --from n: n through latest. Only --to m: the latest 10 Turns ending at m. Bounds are intersected with existing Turns (to is clamped before choosing the default from); an empty range returns from=null and to=null. from>to, non-integers and values below 1 are invalid. At most 50 Turns may be returned; larger effective ranges are rejected. Text per Turn is not truncated.
The response includes totalTurns (before message filtering), from, to and turns. Turn numbers stay fixed when new Turns are appended; use an older --to to read earlier context, or omit both bounds to read the latest context.
Text messages output starts with totalTurns/from/to, then Thread metadata and ---; each Turn has a #<turnNumber> <status> section with verbatim user and final reply text. Compact result output keeps the latest nonempty progress while running, omitted once stopped.`;

const COMMAND_HELP = {
  "host info": `codexhost host info [--refresh true|false] [--format json|compact|text]
Read this Host's environment, tools and workspace defaults. Cached observations expire after 60 seconds.`,
  "project list": `codexhost project list [--query <text>] [--offset <n>] [--limit <n>] [--refresh true|false] [--format json|compact|text]
Discover projects under this Host's configured roots. Returns live project metadata and pagination; no static project registry is required.`,
  "thread file": `codexhost thread file <thread> --path <file> [--offset <n>] [--limit <bytes>] [--revision <revision>] [--format json|compact|text]
Read a file explicitly linked in the latest final report, inside the Thread workspace. Returns a base64 chunk, revision, nextOffset and eof. Continue with the returned revision; restart if it changes. Maximum chunk size is 1 MiB. Read through the execution Host.`,
  "client add": `codexhost client add <name>
Register a named external client for HTTP/MCP or a separate CLI identity. Normal same-user CLI calls authenticate automatically and do not need registration. Prints the client token once; it is not stored in a readable form and cannot be shown again.
The client sets CODEXHOST_CLIENT_TOKEN (or CODEXHOST_CLIENT_TOKEN_FILE) and then uses the same delegate, thread and harness commands, or the MCP endpoint, against the external client listener (127.0.0.1:4398 unless CODEXHOST_EXTERNAL_CLIENT_PORT says otherwise).
Names use lowercase letters, digits and hyphens; local-cli is reserved.`,
  events: `codexhost events [--after <id>] [--limit <n>] [--follow true|false]
For external clients: read the client's event log. Without --after, every retained event is returned, oldest first; keep the cursor to read only new ones. An event reports that a Thread the client watches stopped (outcome, Thread, Turn, Harness, deep link, references); it never carries Thread content, so read the Thread for results.
Without --follow, prints {events, cursor} once; pass cursor back as --after. With --follow true, prints one JSON line per event until interrupted.
Events are kept for 7 days (CODEXHOST_CLIENT_EVENT_RETENTION_DAYS). CURSOR_EXPIRED means older events were removed: reconcile with thread list --client <name>.
The listener also serves GET /v1/events as server-sent events (resume with Last-Event-ID) and POST /v1/events/poll for long-polling.`,
  "client list": `codexhost client list
List registered external clients with their registration time. Tokens are never shown.`,
  "client remove": `codexhost client remove <name>
Revoke a client immediately. Its later requests are rejected with UNAUTHORIZED and its open event streams are closed. Threads it started remain.`,
  "harness list": `codexhost harness list [--format json|compact|text]
List Harnesses available in the active Runtime.`,
  "harness inspect": `codexhost harness inspect <harness> [--cwd <path>] [--refresh true|false] [--format json|compact|text]
Read available Models, native defaults, Thinking options, and configuration capabilities.
Use the returned Model and Thinking IDs for explicit selections.`,
  "delegate start": `codexhost delegate start --harness <id> (--task <text> | --task-file <path|->) [--task-name <name>] [--cwd <path>] [--worktree <branch>] [--base <ref>] [--model <model>] [--thinking <thinking>] [--parent-thread <thread>] [--request-id <id>] [--ref <uri>]... [--watch true|false] [--watch-timeout-ms <n>] [--format json|compact|text]
Create an independent child Thread, submit the task, and return immediately.
--task and --task-file are mutually exclusive. --task-file reads UTF-8 from a file, or stdin for -; maximum 262144 bytes (256 KiB) before removing one final LF or CRLF. Other whitespace and special characters are preserved; empty/whitespace-only input is rejected. Terminal stdin is rejected: use a quoted heredoc (<<'EOF') or a pipe. --task is unchanged.
--task-name supplies a short subtask name (1-120 characters); otherwise the first task line is used.
The child title is the subtask name only, fixed at creation; parent titles are not appended. Existing Threads are not renamed.
Omit --model and --thinking to use the Harness native defaults. Either the catalog id or the nativeId shown by harness inspect is accepted.
--cwd overrides the child workspace; a relative path resolves against the caller process cwd. Otherwise use the resolved parent Thread workspace, then the Host Runtime process cwd.
--worktree creates a new branch and workspace at <main-repository>.worktrees/<sanitized-branch>, then uses it as the child cwd. The source is --cwd, or the caller process cwd when omitted (not the parent Thread workspace).
--base requires --worktree and defaults to that source checkout's HEAD commit, including detached HEAD. JSON and compact responses add worktree {path, branch, base}, where base is the resolved commit SHA. Existing branches/directories, merges, rebases, unmerged indexes, non-Git cwd and unresolved bases are rejected. Uncommitted source changes are not copied.
No automatic merge or cleanup is performed; --request-id does not reuse an existing worktree or branch. If creation or the Runtime request fails after creating artifacts, the error reports any retained worktree/branch in details.worktree (worktreeRetained=true); a failed response can still mean the child started.
--parent-thread overrides caller inference. PARENT_THREAD_AMBIGUOUS requires an explicit parent.
Reuse --request-id for an idempotent retry. Identical recent parent/target/task/configuration requests are also deduplicated briefly.
--watch true also registers thread watch on the child with the resolved parent as the notified Thread; the response's watch field reports whether it was registered.
--ref records where the work came from, such as an issue URL; repeat it for several. Absolute URIs only, at most 16 per Thread; credentials in a URI are removed. A child inherits its parent Thread's references.
An external client that omits --parent-thread starts the work as itself (parent client:<name>) and must pass --cwd.
The response confirms cwd and parent. Use its Thread reference with thread read, wait, send, cancel, or watch.`,
  "thread send": `codexhost thread send <thread> (--message <text> | --message-file <path|->) [--interrupt] [--watch true|false] [--watch-timeout-ms <n>] [--format json|compact|text]
Start a new Turn in a writable Thread and return after submission.
--message and --message-file are mutually exclusive. --message-file reads UTF-8 from a file, or stdin for -; maximum 262144 bytes (256 KiB) before removing one final LF or CRLF. Other whitespace and special characters are preserved; empty/whitespace-only input is rejected. Terminal stdin is rejected: use a quoted heredoc (<<'EOF') or a pipe. --message is unchanged.
Without --interrupt, THREAD_BUSY means the current Turn is still active. Messages are not queued.
--interrupt cancels an active Turn and confirms it stopped before sending (30 s stop timeout); an idle Thread is sent normally. Cancellation failure/timeout sends nothing. It preserves existing watches, suppressing the temporary stop notification; it never retries or queues a failed send.
--watch true registers a watch only after sending succeeds, notifying the resolved caller (CODEXHOST_THREAD_ID, then CODEX_THREAD_ID; otherwise the external client itself). The response's watch field has the same shape as delegate start: watching/alreadyTerminal, or notRegistered with a reason, including a missing caller. --watch-timeout-ms requires --watch true and defaults to 1740000 (29 min).`,
  "thread cancel": `codexhost thread cancel <thread> [--format json|compact|text]
Request cancellation of the active Turn while preserving the Thread and history.
Accepted cancellation also removes all watches on that Thread; thread send --interrupt instead preserves them.
cancelled=true (compact: cancelRequested=true) means the cancellation request was accepted. Read or wait to confirm the terminal state. An idle Thread returns false.`,
  "thread read": `codexhost thread read <thread> [--host <hostId>] [--view result|messages] [--from <n>] [--to <m>] [--format json|compact|text]
Read immediately without starting a Turn. Accepts thread://<id>?hostId=<encoded-host-id> or --host with a bare ID. Explicit remote Hosts use the existing Desktop connection, never local fallback. Requires updated local and remote codexhost; remote send/wait/watch are not supported.
The default result view reports the latest Turn's status and result. Text result output shows Thread metadata, then --- and verbatim result text. Full JSON retains the complete snapshot. Tool calls/output, file activity, and reasoning are not included.
${MESSAGE_VIEW_HELP}`,
  "thread export": `codexhost thread export <thread> [--out <path>] [--format json|compact|text]
Rarely needed: debugging only. Exports the full Thread to a JSON file and returns its path.`,
  "thread wait": `codexhost thread wait <thread> [--timeout-ms <n>] [--view result|messages] [--from <n>] [--to <m>] [--format json|compact|text]
Wait until the Thread is terminal or the timeout expires (default 30000 ms), then return the same snapshot as thread read plus timedOut.
timedOut=true is a running checkpoint: the child keeps running. The response already includes the result when available; another read is unnecessary unless more information is needed.
${MESSAGE_VIEW_HELP}`,
  "thread watch": `codexhost thread watch <thread> [--notify <thread>] [--timeout-ms <n>] [--format json|compact|text]
Ask the Host to notify one Thread, once, when the watched Thread stops. Returns immediately; no waiting or polling by the caller is needed, and the caller may end its Turn.
--notify defaults to the calling Thread when it is identified (CODEXHOST_THREAD_ID, or CODEX_THREAD_ID in native Codex); for an external client it defaults to the client, and the notification becomes an event in its log (see codexhost events). Otherwise it is required. delegate start reports the caller as its parent.
The notification starts a new Turn in the notified Thread with the watched Thread's link and outcome: completed, failed, interrupted, timedOut, unreadable, or notFound. It reports execution state only and asks the notified agent to read each Thread's result before continuing.
Link labels use the observed title (Thread id if unavailable); a suffix after " · " is limited to 20 characters plus an ellipsis without renaming the Thread.
--timeout-ms defaults to 1740000 (29 min). timedOut means the Thread had not reached a terminal state, which also covers a Harness that stopped without reporting it; watch again to keep waiting. unreadable means reads failed for 60 s, so the state is unknown.
state=watching means registered. state=alreadyTerminal means the Thread was not running: nothing was registered and nothing will be sent.
A busy notified Thread is notified after its Turn ends (retried for up to 6 hours); notifications due together arrive as one message. THREAD_BUSY is never treated as delivered.
A watch is one-shot with no standalone unsubscribe command; an accepted thread cancel removes all watches on the watched Thread. Watching the same pair again while it is still watched returns that watch; once it has stopped, a new watch covers the next stop and any pending notification is still delivered. Watches are stored and resume after a Host Runtime restart; a notification whose delivery was in progress when the Runtime stopped is sent again, so a restart may repeat one. A Turn that was running when the Runtime restarted is reported as interrupted, because the restart ended its Harness process.`,
  "thread watches": `codexhost thread watches [--format json|compact|text]
List watches that have not been delivered: watching, pendingDelivery (waiting for the notified Thread), or undeliverable (with the reason). Delivered watches are removed.
Entries include taskName when known, threadStatus when readable, and watchedForMs since registration (including downtime). Text prints one watch per line.`,
  "thread list": `codexhost thread list [--cwd <path>] [--parent <thread> | --client <name>] [--ref <uri>] [--limit <n>] [--cursor <cursor>] [--sort created-asc|created-desc|updated-asc|updated-desc|recency-asc|recency-desc] [--format json|compact|text]
Find existing Threads by workspace, or use --parent to list a Thread's delegated children.
Workspace listing defaults to the caller process cwd. Default limit 25 (maximum 100), sorted created-desc.
--parent uses Delegation relationships. --client lists what an external client started without a parent Thread. --ref lists Threads carrying that reference, newest first, across workspaces. An external client lists all workspaces unless --cwd is given. A null nextCursor ends the list.
Compact output keeps task links, Harness, status, title, and workspace.`,
} as const;

export type DelegationCliCommand = keyof typeof COMMAND_HELP;

const COMMON_HELP = `Thread references accept a bare ID or codex://threads/<id>.
Options accept --name <value> or --name=<value>. --task, --task-name, and --message take the next argument verbatim, even when it is empty or starts with --.
--format json is the compatible full JSON output (default); --format compact returns concise JSON using task links instead of internal IDs.
--format text returns readable key/value lines with unescaped Thread bodies and at least the compact fields. It is not supported by client or events commands; unsupported commands return an explicit error. Errors remain JSON on stderr in every format.
Success is written to stdout; errors {"error":{"code":"...","message":"...","details":{...}}} go to stderr with exit code 1. Exit code 0 means the command succeeded, not that the delegated task succeeded.
read/wait are non-consuming. Native Codex callers need local Runtime access; RUNTIME_UNREACHABLE requires the Host-provided environment and a sandbox that permits that connection.
Native Codex shell commands also need the Host-provided CODEXHOST_* environment variables. If shell_environment_policy filters them, prefer inherit = "all" with ignore_default_excludes = true and a narrow include_only containing "CODEXHOST_RUNTIME_ENDPOINT" and "CODEXHOST_RUNTIME_TOKEN" plus the variables required by the platform and invoked tools. Avoid unconstrained inherit = "all", which forwards unrelated ambient variables.`;

const COMMAND_TAIL = `Thread references accept a bare ID or codex://threads/<id>.
Options accept --name <value> or --name=<value>. --task, --task-name, and --message take the next argument verbatim, even when it is empty or starts with --.
Output formats, errors and environment requirements: codexhost delegate --help.`;

export const DELEGATION_HELP = `usage:
  codexhost host info
  codexhost project list
  codexhost thread file <thread> --path <file>
  codexhost harness list
  codexhost harness inspect <harness>
  codexhost delegate start --harness <id> (--task <text> | --task-file <path|->)
  codexhost thread send <thread> (--message <text> | --message-file <path|->) [--interrupt] [--watch true]
  codexhost thread cancel <thread>
  codexhost thread read <thread>
  codexhost thread export <thread> (rarely needed)
  codexhost thread wait <thread>
  codexhost thread watch <thread>
  codexhost thread watches
  codexhost thread list
  codexhost client add|list|remove
  codexhost events

Use <command> --help for its options. Use harness list to discover targets.
Outside a codexhost session, the CLI reads private cli-credentials.json from the local data directory automatically. The Host and its external listener must be running. No client add or token environment variable is needed; these calls share the local-cli identity. Explicit client credentials override discovery.
${COMMON_HELP}
`;

function hasHelpOption(arguments_: readonly string[]): boolean {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") return true;
    if (argument && consumesNextArgument(argument, arguments_[index + 1])) index += 1;
  }
  return false;
}

export function delegationCliHelp(arguments_: readonly string[]): string | undefined {
  const [group, command, ...rest] = arguments_;
  if (!group || group === "--help" || group === "-h") return DELEGATION_HELP;
  if (group === "events" && hasHelpOption([command ?? "", ...rest]))
    return `${COMMAND_HELP.events}\n\n${COMMAND_TAIL}\n`;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    if (group === "delegate") return DELEGATION_HELP;
    if (
      group === "host" ||
      group === "project" ||
      group === "harness" ||
      group === "thread" ||
      group === "client"
    ) {
      const usages = Object.entries(COMMAND_HELP)
        .filter(([name]) => name.startsWith(`${group} `))
        .map(([, help]) => help.split("\n")[0]);
      return `${usages.join("\n")}\n\n${COMMAND_TAIL}\n`;
    }
  }
  if (hasHelpOption(rest)) {
    const name = `${group} ${command}`;
    if (Object.hasOwn(COMMAND_HELP, name)) {
      return `${COMMAND_HELP[name as DelegationCliCommand]}\n\n${COMMAND_TAIL}\n`;
    }
  }
  return undefined;
}

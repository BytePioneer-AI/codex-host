import {
  harnessCommandCatalogSchema,
  harnessCommandDescriptorSchema,
  type HarnessCommandCatalog,
  type HarnessCommandDescriptor,
} from "@codexhost/shared-contracts";

/**
 * Native commands that do not belong in Codex Desktop, by name. They replace or
 * reset the native Session behind the Host's history, change configuration the
 * Desktop owns (Model, effort, permissions), change trust or approval policy,
 * need a native login or terminal UI, manage plugins, or start work that
 * outlives the Turn (loops, schedules, background jobs, goals).
 *
 * Applied to live commands only; curated Adapter built-ins are not filtered.
 * Skills are never matched by this list, so a user skill is not hidden because
 * it shares a name with a native command. A command left out of the catalog is
 * also rejected when typed, because the Host only runs catalog commands.
 */
export const COMMON_EXCLUDED_LIVE_COMMANDS: ReadonlySet<string> = new Set([
  // Session lifecycle
  "branch",
  "clear",
  "exit",
  "fork",
  "fresh",
  "new",
  "quit",
  "rename",
  "rename-chat",
  "reset",
  "resume",
  "rewind",
  "session",
  "sessions",
  // Desktop-owned configuration
  "autocompact",
  "color",
  "config",
  "effort",
  "fast",
  "keybindings",
  "model",
  "models",
  "output-style",
  "permissions",
  "settings",
  "statusline",
  "terminal-setup",
  "theme",
  "vim",
  // Trust and approval policy
  "always-approve",
  "auto-mode-setup",
  // Native login
  "login",
  "logout",
  // Work outliving the Turn
  "autopilot",
  "background",
  "bg",
  "goal",
  "jobs",
  "loop",
  "multitask",
  "queue",
  "remote-control",
  "schedule",
  "steer",
  // Native terminal UI
  "copy",
  "debug",
  "feedback",
  "heapdump",
  "share",
  "shell",
  // Plugin and MCP management
  "marketplace",
  "mcp",
  "plugins",
  "reload-plugins",
]);

/** Name prefixes excluded like {@link COMMON_EXCLUDED_LIVE_COMMANDS}: internal and hook management. */
export const COMMON_EXCLUDED_LIVE_COMMAND_PREFIXES: readonly string[] = ["__", "hooks-"];

/** Adapter-specific exclusions; these apply to commands and skills alike. */
export interface LiveCommandExclusions {
  names?: Iterable<string>;
  prefixes?: readonly string[];
}

export function isExcludedLiveCommand(
  name: string,
  kind: "command" | "skill",
  extra: LiveCommandExclusions = {},
): boolean {
  const normalized = name.trim().replace(/^\//u, "");
  if (new Set(extra.names ?? []).has(normalized)) return true;
  if (extra.prefixes?.some((prefix) => normalized.startsWith(prefix))) return true;
  if (kind === "skill") return false;
  return (
    COMMON_EXCLUDED_LIVE_COMMANDS.has(normalized) ||
    COMMON_EXCLUDED_LIVE_COMMAND_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

/** A command or skill reported by a running native Session. */
export interface LiveHarnessCommand {
  /** Native name without the leading slash. */
  name: string;
  description?: string;
  kind: "command" | "skill";
}

/**
 * Adapter-owned catalog of the commands a live native Session reports.
 *
 * Built-ins keep their dedicated handling and win on name clashes. Every live
 * entry gets a namespaced id and accepts text, so the Composer claims it for
 * the user to complete instead of running it blindly; execution sends the
 * native slash text as an ordinary prompt Turn.
 */
export class LiveHarnessCommandCatalog {
  readonly #idPrefix: string;
  readonly #builtIns: HarnessCommandCatalog;
  #catalog: HarnessCommandCatalog;

  readonly #exclusions: LiveCommandExclusions;

  constructor(options: {
    idPrefix: string;
    builtIns: HarnessCommandCatalog;
    exclusions?: LiveCommandExclusions;
  }) {
    this.#idPrefix = options.idPrefix;
    this.#builtIns = options.builtIns;
    this.#exclusions = options.exclusions ?? {};
    this.#catalog = options.builtIns;
  }

  /** Current catalog: built-ins plus the latest live commands. */
  get catalog(): HarnessCommandCatalog {
    return this.#catalog;
  }

  /** Replace the live part; `null` returns to built-ins only. */
  update(live: readonly LiveHarnessCommand[] | null): HarnessCommandCatalog {
    this.#catalog = mergeLiveHarnessCommands(
      this.#builtIns,
      this.#idPrefix,
      live,
      this.#exclusions,
    );
    return this.#catalog;
  }

  /** Native prompt text for a live command id, or null for built-ins and unknown ids. */
  promptFor(commandId: string, argumentText: unknown): string | null {
    return liveHarnessCommandPrompt(this.#catalog, this.#idPrefix, commandId, argumentText);
  }
}

/**
 * Native slash text (`/name arguments`) for a live command id; null for
 * built-ins and ids the catalog does not contain.
 */
export function liveHarnessCommandPrompt(
  catalog: HarnessCommandCatalog,
  idPrefix: string,
  commandId: string,
  argumentText: unknown,
): string | null {
  if (!commandId.startsWith(idPrefix)) return null;
  const descriptor = catalog.commands.find(({ id }) => id === commandId);
  if (!descriptor) return null;
  const text = typeof argumentText === "string" ? argumentText.trim() : "";
  return text ? `${descriptor.invocation} ${text}` : descriptor.invocation;
}

export function mergeLiveHarnessCommands(
  builtIns: HarnessCommandCatalog,
  idPrefix: string,
  live: readonly LiveHarnessCommand[] | null,
  exclusions: LiveCommandExclusions = {},
): HarnessCommandCatalog {
  if (!live) return builtIns;
  const invocations = new Set(builtIns.commands.map(({ invocation }) => invocation));
  const ids = new Set<string>(builtIns.commands.map(({ id }) => id));
  const dynamic: HarnessCommandDescriptor[] = [];
  for (const command of live) {
    const name = command.name.trim().replace(/^\//u, "");
    // Slash invocations are single tokens for Host matching and Composer chips.
    if (!name || /\s/u.test(name)) continue;
    if (isExcludedLiveCommand(name, command.kind, exclusions)) continue;
    const invocation = `/${name}`;
    const id = `${idPrefix}${name.replace(/[^A-Za-z0-9._:-]/gu, "-")}`.slice(0, 128);
    if (invocations.has(invocation) || ids.has(id)) continue;
    const description = command.description?.trim().slice(0, 512);
    const parsed = harnessCommandDescriptorSchema.safeParse({
      id,
      invocation,
      label: name.slice(0, 128),
      ...(description ? { description } : {}),
      argumentMode: "text",
      kind: command.kind,
    });
    if (!parsed.success) continue;
    invocations.add(invocation);
    ids.add(id);
    dynamic.push(parsed.data);
  }
  return harnessCommandCatalogSchema.parse({ commands: [...builtIns.commands, ...dynamic] });
}

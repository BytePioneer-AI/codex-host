import type { HarnessCommandInvocation, HarnessResult } from "@codexhost/harness-adapter";
import {
  harnessCommandCatalogSchema,
  type HarnessCommandCatalog,
} from "@codexhost/shared-contracts";
import {
  CODEBUDDY_RUNTIME_PROFILE,
  failure,
  record,
  rows,
  text,
  type CodeBuddyRuntimeProfile,
} from "./common.js";

// These native commands switch Session identity, detach work, or require a native UI.
// They cannot execute through the Host's current-Session command contract.
const excluded = new Set([
  "background",
  "bg",
  "branch",
  "fork",
  "fork-bg",
  "clear",
  "resume",
  "exit",
  "rewind",
  "multitask",
  "agent-mode",
  "btw",
  "loop",
  "goal",
  "login",
  "logout",
  "feedback",
  "keybindings",
  "copy",
  "statusline",
  "gateway",
  "remote-control",
  "_compact",
]);

export function isExcludedInvocation(invocation: string | undefined): boolean {
  return invocation?.startsWith("/") === true && excluded.has(invocation.slice(1));
}

export function nativeCommandsEnabled(
  profile: CodeBuddyRuntimeProfile = CODEBUDDY_RUNTIME_PROFILE,
) {
  return profile.nativeCommands ?? profile.harnessId === CODEBUDDY_RUNTIME_PROFILE.harnessId;
}

export function commandCatalog(
  value: unknown,
  profile: CodeBuddyRuntimeProfile = CODEBUDDY_RUNTIME_PROFILE,
): HarnessCommandCatalog {
  const seen = new Set<string>();
  return {
    commands: rows(value).flatMap((entry) => {
      const name = text(entry.name).replace(/^\//u, "");
      if (excluded.has(name) || seen.has(name)) return [];
      const parsed = harnessCommandCatalogSchema.safeParse({
        commands: [
          {
            id: `${profile.harnessId}.${name}`,
            invocation: `/${name}`,
            label: name,
            ...(text(entry.description).trim()
              ? { description: text(entry.description).trim().slice(0, 512) }
              : {}),
            argumentMode:
              name === "compact" || record(entry.input).hint || record(entry._meta).type === "skill"
                ? "text"
                : "none",
          },
        ],
      });
      if (!parsed.success) return [];
      seen.add(name);
      return parsed.data.commands;
    }),
  };
}

// The Host reads Adapter metadata without opening a native Session. Publish only
// verified built-ins here; execution still checks the Session's live ACP catalog.
export const CODEBUDDY_COMMAND_CATALOG: HarnessCommandCatalog = commandCatalog([
  {
    name: "compact",
    description: "Summarize conversation context with optional focus instructions",
  },
  { name: "cost", description: "Show current Session usage and cost" },
]);

export function commandPrompt(
  command: HarnessCommandInvocation,
  catalog: HarnessCommandCatalog,
  profile: CodeBuddyRuntimeProfile = CODEBUDDY_RUNTIME_PROFILE,
): HarnessResult<string> {
  const descriptor = catalog.commands.find((entry) => entry.id === command.commandId);
  if (!descriptor)
    return failure("unsupported", "Command is not available in this Session", profile);
  const args = command.arguments;
  if (
    args &&
    (Object.keys(args).some((key) => key !== "text") ||
      (args.text !== undefined && typeof args.text !== "string") ||
      (descriptor.argumentMode === "none" && Object.keys(args).length > 0))
  )
    return failure("invalidRequest", "Command arguments must match the native command", profile);
  const argument = typeof args?.text === "string" ? args.text.trim() : "";
  return { ok: true, value: `${descriptor.invocation}${argument ? ` ${argument}` : ""}` };
}

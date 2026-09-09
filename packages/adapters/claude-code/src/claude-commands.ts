import {
  harnessCommandCatalogSchema,
  harnessCommandDescriptorSchema,
  type HarnessCommandCatalog,
} from "@codexhost/shared-contracts";

export interface ClaudeNativeCommand {
  name: string;
  description: string;
  argumentHint: string;
}

// These controls replace identity, require terminal UI, or bypass the Host's model/account controls.
const reserved = new Set([
  "compact",
  "init",
  "recap",
  "clear",
  "new",
  "resume",
  "fork",
  "exit",
  "quit",
  "import",
  "model",
  "effort",
  "fast",
  "config",
  "permissions",
  "permission",
  "login",
  "logout",
  "color",
  "rename",
  "heapdump",
  "__remote-workflow",
  "workflow-launch-exec",
  "context",
  "usage",
  "usage-credits",
  "extra-usage",
  "mcp",
  "reload-skills",
  "doctor",
  "agents",
  "design-consent",
  "design-revoke",
  "design",
  "goal",
  "auto-mode-setup",
  "team-onboarding",
  "run",
]);

export function claudeNativeCommandCatalog(
  base: HarnessCommandCatalog,
  native: readonly ClaudeNativeCommand[],
): HarnessCommandCatalog {
  const commands = [...base.commands];
  const names = new Set<string>();
  for (const command of native) {
    const name = command.name;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(name) || reserved.has(name) || names.has(name))
      continue;
    names.add(name);
    commands.push(
      harnessCommandDescriptorSchema.parse({
        id: `claude.native.${name}`,
        invocation: `/claude:${name}`,
        label: name,
        description: command.description?.trim().slice(0, 512) || name,
        argumentMode: "text",
        executionMode: "prompt",
      }),
    );
  }
  return harnessCommandCatalogSchema.parse({ commands });
}

export function claudeNativePrompt(text: string, catalog: HarnessCommandCatalog): string {
  if (!text.trimStart().startsWith("/claude:")) return text;
  const candidate = text.trimStart();
  const token = candidate.match(/^\S+/u)?.[0];
  if (
    !catalog.commands.some(
      (command) => command.executionMode === "prompt" && command.invocation === token,
    )
  ) {
    throw new Error("Claude Code command is no longer available in the Native Session");
  }
  return `/${candidate.slice("/claude:".length)}`;
}

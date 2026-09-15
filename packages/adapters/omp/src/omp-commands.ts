import {
  harnessCommandCatalogSchema,
  harnessCommandDescriptorSchema,
  type HarnessCommandCatalog,
} from "@codexhost/shared-contracts";

export interface OmpNativeCommand {
  name: string;
  description?: string;
  source: string;
}

// Native Session replacement and terminal-only controls cannot be projected as Turns.
const promptSources = new Set(["file", "skill"]);
const reserved = new Set([
  "compact",
  "clear",
  "new",
  "resume",
  "branch",
  "fork",
  "quit",
  "exit",
  "model",
  "switch",
  "login",
  "logout",
]);

export function ompNativeCommandCatalog(
  base: HarnessCommandCatalog,
  native: readonly OmpNativeCommand[],
): HarnessCommandCatalog {
  const commands = [...base.commands];
  const names = new Set<string>();
  for (const command of native) {
    const name = command.name;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(name) || reserved.has(name) || names.has(name))
      continue;
    if (!promptSources.has(command.source)) continue;
    names.add(name);
    commands.push(
      harnessCommandDescriptorSchema.parse({
        id: `omp.native.${name}`,
        invocation: `/omp:${name}`,
        label: name,
        description: command.description?.trim().slice(0, 512) || name,
        argumentMode: "text",
        executionMode: "prompt",
      }),
    );
  }
  return harnessCommandCatalogSchema.parse({ commands });
}

export function ompNativePrompt(text: string, catalog: HarnessCommandCatalog): string {
  if (!text.trimStart().startsWith("/omp:")) return text;
  const candidate = text.trimStart();
  const token = candidate.match(/^\S+/u)?.[0];
  if (
    !catalog.commands.some(
      (command) => command.executionMode === "prompt" && command.invocation === token,
    )
  ) {
    throw new Error("OMP command is no longer available in the Native Session");
  }
  return `/${candidate.slice("/omp:".length)}`;
}

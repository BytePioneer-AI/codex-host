import { harnessCommandCatalogSchema } from "@codexhost/shared-contracts";
export const COMMAND_CATALOG = harnessCommandCatalogSchema.parse({
  commands: [
    {
      id: "compact",
      invocation: "/compact",
      label: "Compact",
      description: "Compact the native ZCode conversation.",
      argumentMode: "text",
    },
    {
      id: "goal",
      invocation: "/goal",
      label: "Goal",
      description: "Set, inspect, pause, resume, replace or clear the native ZCode goal.",
      argumentMode: "text",
    },
  ],
});
export function goalArguments(value: string) {
  const [verb, ...words] = value.trim().split(/\s+/u);
  if (["show", "pause", "resume", "clear"].includes(verb ?? "")) return { action: verb };
  if (verb === "replace") return { action: "replace", objective: words.join(" ") };
  return value.trim() ? { action: "set", objective: value.trim() } : { action: "show" };
}

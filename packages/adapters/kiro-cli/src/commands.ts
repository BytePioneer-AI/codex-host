import {
  harnessCommandCatalogSchema,
  type HarnessCommandCatalog,
  type HarnessCommandDescriptor,
} from "@codexhost/shared-contracts";

export const KIRO_COMMANDS: HarnessCommandDescriptor[] = [
  {
    id: "kiro.compact" as HarnessCommandDescriptor["id"],
    invocation: "/compact",
    label: "Compact Conversation",
    description: "Summarize conversation history to free context window",
    argumentMode: "none",
  },
  {
    id: "kiro.context" as HarnessCommandDescriptor["id"],
    invocation: "/kiro-context",
    label: "Show Context",
    description: "Show context usage details",
    argumentMode: "none",
  },
  {
    id: "kiro.usage" as HarnessCommandDescriptor["id"],
    invocation: "/kiro-usage",
    label: "Show Account Usage",
    description: "Show Kiro account usage and quota",
    argumentMode: "none",
  },
  {
    id: "kiro.plan" as HarnessCommandDescriptor["id"],
    invocation: "/kiro-plan",
    label: "Plan Mode",
    description: "Switch to Kiro Plan mode",
    argumentMode: "none",
  },
  {
    id: "kiro.spec" as HarnessCommandDescriptor["id"],
    invocation: "/kiro-spec",
    label: "Spec Mode",
    description: "Switch to Kiro Spec mode",
    argumentMode: "none",
  },
  {
    id: "kiro.vibe" as HarnessCommandDescriptor["id"],
    invocation: "/kiro-vibe",
    label: "Vibe Mode",
    description: "Switch to Kiro Vibe mode",
    argumentMode: "none",
  },
];

export const KIRO_COMMAND_CATALOG: HarnessCommandCatalog =
  harnessCommandCatalogSchema.parse({
    commands: KIRO_COMMANDS,
  });

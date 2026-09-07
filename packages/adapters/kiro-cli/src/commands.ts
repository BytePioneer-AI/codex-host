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

export const KIRO_COMMAND_CATALOG: HarnessCommandCatalog = harnessCommandCatalogSchema.parse({
  commands: KIRO_COMMANDS,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cell(value: unknown): string {
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? new Intl.NumberFormat("en", { maximumFractionDigits: 4 }).format(value)
      : "-";
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value !== "string") return "-";
  return value.replace(/[\\`*_[\]<>|]/gu, "\\$&").replace(/\r?\n/gu, " ");
}

function table(headers: string[], rows: unknown[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

export function formatKiroCommandResult(commandId: string, result: unknown): string {
  if (["kiro.plan", "kiro.spec", "kiro.vibe"].includes(commandId)) {
    return `**Kiro mode:** ${cell(result)}`;
  }
  const json =
    JSON.stringify(
      result,
      (key, value: unknown) => {
        if (
          /^(?:(?:access|refresh|auth|id)[_-]?)?token$|password|secret|authorization|api.?key/iu.test(
            key,
          )
        ) {
          return "[redacted]";
        }
        return typeof value === "string"
          ? value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]")
          : value;
      },
      2,
    ) ?? "null";
  const clean: unknown = JSON.parse(json);
  if (isRecord(clean) && clean.success === false) {
    throw new Error("Kiro could not complete the requested query");
  }
  const data = isRecord(clean) && isRecord(clean.data) ? clean.data : clean;
  if (commandId === "kiro.usage" && isRecord(data) && Array.isArray(data.usageBreakdowns)) {
    const sections = [
      "## Kiro Account Usage",
      table(
        ["Account", "Value"],
        [
          ["Plan", data.planName],
          ["Billing cycle reset", data.billingCycleReset],
          ["Overages enabled", data.overagesEnabled],
        ],
      ),
      "### Resources",
      table(
        ["Resource", "Used", "Limit", "Used (%)"],
        data.usageBreakdowns
          .filter(isRecord)
          .map((entry) => [
            entry.displayName ?? entry.resourceType,
            entry.used,
            entry.hasLimit === false ? "No limit" : entry.limit,
            entry.percentage,
          ]),
      ),
    ];
    for (const [key, label] of [
      ["bonusCredits", "Bonus Credits"],
      ["addOnCredits", "Add-on Credits"],
    ] as const) {
      if (Array.isArray(data[key]) && data[key].length > 0) {
        sections.push(`### ${label}`, jsonBlock(JSON.stringify(data[key], null, 2)));
      }
    }
    return sections.join("\n\n");
  }
  if (commandId === "kiro.context" && isRecord(data) && isRecord(data.breakdown)) {
    const breakdown = data.breakdown;
    const percent = isRecord(data.contextUsage)
      ? data.contextUsage.usagePercentage
      : data.usagePercentage;
    const sections = [
      "## Kiro Context Usage",
      ...(typeof percent === "number" ? [`Context used: **${cell(percent)}%**`] : []),
      table(
        ["Category", "Tokens", "Native share (%)"],
        [
          ["yourPrompts", "Your prompts"],
          ["kiroResponses", "Kiro responses"],
          ["tools", "Tools"],
          ["contextFiles", "Context files"],
          ["sessionFiles", "Session files"],
        ].flatMap(([key, label]) => {
          const entry = key ? breakdown[key] : undefined;
          return isRecord(entry) ? [[label, entry.tokens, entry.percent]] : [];
        }),
      ),
    ];
    for (const key of ["contextFiles", "sessionFiles"]) {
      const entry = breakdown[key];
      if (isRecord(entry) && Array.isArray(entry.items) && entry.items.length > 0) {
        sections.push(
          `### ${key === "contextFiles" ? "Context Files" : "Session Files"}`,
          jsonBlock(JSON.stringify(entry.items, null, 2)),
        );
      }
    }
    if (Array.isArray(data.entries) && data.entries.length > 0) {
      sections.push("### Entries", jsonBlock(JSON.stringify(data.entries, null, 2)));
    }
    return sections.join("\n\n");
  }
  return `## Kiro Query Result\n\n${jsonBlock(json)}`;
}

function jsonBlock(json: string): string {
  const limit = 64_000;
  const text = json.length > limit ? `${json.slice(0, limit)}\n[Output truncated]` : json;
  const fence = "`".repeat(
    Math.max(3, ...(text.match(/`+/gu) ?? []).map((match) => match.length + 1)),
  );
  return `${fence}json\n${text}\n${fence}`;
}

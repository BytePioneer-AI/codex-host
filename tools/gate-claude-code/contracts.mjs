import { z } from "zod";

export const CLAUDE_PROBE_SCHEMA_VERSION = 1;
export const scenarioStatusSchema = z.enum(["PASS", "FAIL", "BLOCKED"]);
export const scenarioProfileSchema = z.enum(["hermetic", "inspect", "live"]);

const factValueSchema = z.union([
  z.boolean(),
  z.number().finite(),
  z.string().min(1),
  z.array(z.string()),
]);

export const blockerSchema = z
  .object({
    category: z.enum([
      "installation",
      "launch",
      "authentication",
      "network",
      "quota",
      "platform",
      "protocol",
    ]),
    resolution: z.string().min(1),
  })
  .strict();

export const scenarioResultSchema = z
  .object({
    id: z.string().min(1),
    profile: scenarioProfileSchema,
    required: z.boolean(),
    status: scenarioStatusSchema,
    checks: z.record(z.string(), z.boolean()),
    facts: z.record(z.string(), factValueSchema),
    blocker: blockerSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "BLOCKED" && value.blocker === undefined) {
      context.addIssue({
        code: "custom",
        message: "BLOCKED scenarios require a blocker",
        path: ["blocker"],
      });
    }
    if (value.status !== "BLOCKED" && value.blocker !== undefined) {
      context.addIssue({
        code: "custom",
        message: "only BLOCKED scenarios may have a blocker",
        path: ["blocker"],
      });
    }
  });

export const capabilityResultSchema = z
  .object({
    id: z.string().min(1),
    required: z.boolean(),
    status: z.enum(["supported", "unsupported", "not-observed", "blocked"]),
    evidence: z.array(z.string().min(1)),
  })
  .strict();

export const probeReportSchema = z
  .object({
    schemaVersion: z.literal(CLAUDE_PROBE_SCHEMA_VERSION),
    gate: z.literal("claude-code-adapter-semantics"),
    status: scenarioStatusSchema,
    platform: z.string().min(1),
    architecture: z.string().min(1),
    commandSource: z.enum(["environment", "path"]),
    sdkVersion: z.string().min(1),
    sdkClaudeCodeVersion: z.string().min(1),
    cliVersion: z.string().min(1),
    scenarios: z.array(scenarioResultSchema),
    capabilities: z.array(capabilityResultSchema),
  })
  .strict();

export function scenarioResult(input) {
  const value = scenarioResultSchema.parse(input);
  if (value.status === "PASS" && Object.values(value.checks).some((passed) => passed === false)) {
    throw new Error(`PASS scenario '${value.id}' contains a failed check`);
  }
  return value;
}

export function scenarioStatus(checks) {
  return Object.values(checks).every(Boolean) ? "PASS" : "FAIL";
}

export function overallStatus(scenarios) {
  const required = scenarios.filter(({ required }) => required);
  if (required.some(({ status }) => status === "FAIL")) return "FAIL";
  if (required.some(({ status }) => status === "BLOCKED")) return "BLOCKED";
  return "PASS";
}

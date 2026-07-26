import { z } from "zod";

export const GATE_C_SCHEMA_VERSION = 1;
export const scenarioStatusSchema = z.enum(["PASS", "FAIL", "BLOCKED"]);
export const profileSchema = z.enum(["hermetic", "isolated", "extension", "native-live"]);

export const scenarioResultSchema = z.object({
  id: z.string().min(1),
  profile: profileSchema,
  status: scenarioStatusSchema,
  required: z.boolean(),
  checks: z.record(z.string(), z.boolean()),
  evidence: z.array(z.string()),
  blocker: z.string().min(1).optional(),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
    })
    .optional(),
});

export const capabilityResultSchema = z.object({
  id: z.string().min(1),
  required: z.boolean(),
  status: z.enum(["supported", "unsupported", "not-observed", "blocked"]),
  evidence: z.array(z.string()),
});

export const rawCaptureSchema = z.object({
  schemaVersion: z.literal(GATE_C_SCHEMA_VERSION),
  captureType: z.literal("pi-rpc-scenario"),
  profile: profileSchema,
  scenario: z.string().min(1),
  commandSource: z.enum(["configured", "environment", "path"]),
  platform: z.string().min(1),
  architecture: z.string().min(1),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  frames: z.array(
    z.object({
      direction: z.enum(["stdin", "stdout"]),
      capturedAt: z.number().int().nonnegative(),
      unterminated: z.boolean().optional(),
      value: z.unknown(),
    }),
  ),
  result: scenarioResultSchema,
});

export const syntheticFixtureSchema = z.object({
  schemaVersion: z.literal(GATE_C_SCHEMA_VERSION),
  fixtureType: z.literal("fake-pi-hermetic"),
  scenarios: z.array(scenarioResultSchema),
});

export const gateReportSchema = z.object({
  schemaVersion: z.literal(GATE_C_SCHEMA_VERSION),
  gate: z.literal("pi-rpc-capabilities"),
  status: scenarioStatusSchema,
  recordedAt: z.string().datetime(),
  platform: z.string().min(1),
  architecture: z.string().min(1),
  commandSource: z.enum(["configured", "environment", "path"]),
  evidenceRoot: z.string().min(1),
  scenarios: z.array(scenarioResultSchema),
  capabilities: z.array(capabilityResultSchema),
  impact: z.string().min(1),
  nextDecision: z.string().min(1),
});

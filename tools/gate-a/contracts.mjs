import { z } from "zod";

export const PROBE_SCHEMA_VERSION = 1;

const invocationBase = z.object({
  schemaVersion: z.literal(PROBE_SCHEMA_VERSION),
  recordType: z.literal("invocation"),
  timestampMs: z.number().int().nonnegative(),
  processId: z.number().int().positive(),
  parentProcessId: z.number().int().positive().nullable(),
  invocationKind: z.enum(["app-server", "other"]),
  args: z.array(z.string()),
  cwd: z.string(),
  desktopVersion: z.string(),
  stockCodexPath: z.string(),
  environmentPresence: z.record(z.string(), z.boolean()),
});

export const probeInvocationSchema = z.discriminatedUnion("platform", [
  invocationBase.extend({
    platform: z.literal("windows"),
  }),
  invocationBase.extend({
    platform: z.literal("macos"),
    architecture: z.string().min(1),
    processGroupId: z.number().int().positive(),
    launchMode: z.enum(["launch-services", "direct-executable"]),
  }),
  invocationBase.extend({
    platform: z.literal("linux"),
    architecture: z.literal("x64"),
    processGroupId: z.number().int().positive(),
    launchMode: z.literal("direct-executable"),
  }),
]);

const exitBase = z.object({
  schemaVersion: z.literal(PROBE_SCHEMA_VERSION),
  recordType: z.literal("exit"),
  timestampMs: z.number().int().nonnegative(),
  processId: z.number().int().positive(),
  childProcessId: z.number().int().positive(),
  exitCode: z.number().int().nullable(),
  success: z.boolean(),
  elapsedMs: z.number().int().nonnegative(),
});

export const probeExitSchema = z.discriminatedUnion("platform", [
  exitBase.extend({ platform: z.literal("windows") }),
  exitBase.extend({
    platform: z.literal("macos"),
    exitSignal: z.number().int().positive().nullable(),
  }),
  exitBase.extend({
    platform: z.literal("linux"),
    exitSignal: z.number().int().positive().nullable(),
  }),
]);

export const differentialResultSchema = z.object({
  schemaVersion: z.literal(PROBE_SCHEMA_VERSION),
  directVersion: z.string(),
  shimVersion: z.string(),
  byteLayerEqual: z.boolean(),
  protocolScenarios: z.array(
    z.object({
      name: z.string(),
      equal: z.boolean(),
      direct: z.unknown(),
      shim: z.unknown(),
    }),
  ),
  unknownDifferences: z.array(z.string()),
});

export const macosDifferentialSummarySchema = z.object({
  schemaVersion: z.literal(PROBE_SCHEMA_VERSION),
  platform: z.literal("macos"),
  capturedAt: z.string(),
  architecture: z.string().min(1),
  desktopVersion: z.string().min(1),
  directVersion: z.string().min(1),
  shimVersion: z.string().min(1),
  byteLayerEqual: z.boolean(),
  protocolScenarios: z.array(
    z.object({
      name: z.string(),
      equal: z.boolean(),
      directPassed: z.boolean().nullish(),
      shimPassed: z.boolean().nullish(),
    }),
  ),
  unknownDifferences: z.array(z.string()),
  privacyReview: z.string().min(1),
});

export const macosLifecycleSummarySchema = z.object({
  schemaVersion: z.literal(PROBE_SCHEMA_VERSION),
  platform: z.literal("macos"),
  capturedAt: z.string(),
  architecture: z.string().min(1),
  desktopVersion: z.string().min(1),
  codexCliVersion: z.string().min(1),
  launchMode: z.literal("launch-services"),
  scenarios: z.object({
    desktopNormalExit: z.literal(true),
    externalSigterm: z.literal(true),
    externalSigint: z.literal(true),
    externalSighup: z.literal(true),
    concurrentShutdownSingleTerminal: z.literal(true),
    ignoredSignalEscalation: z.literal(true),
    stdinEof: z.literal(true),
    officialCliCrash: z.literal(true),
    shimForcedTermination: z.literal(true),
    desktopForcedTermination: z.literal(true),
    observedEscapedDescendantCleanup: z.literal(true),
    directGuiVisible: z.literal(true),
    directSingleInstanceRefusal: z.literal(true),
    directNormalExit: z.literal(true),
    directErrorPropagation: z.literal(true),
    noOrphanProcesses: z.literal(true),
  }),
  blockedScenarios: z.array(z.string()),
  privacyReview: z.string().min(1),
});

const interactiveScenariosSchema = z.object({
  isolatedLaunch: z.literal(true),
  processScopedEnvironment: z.literal(true),
  newThread: z.literal(true),
  continueThread: z.literal(true),
  streamingReply: z.literal(true),
  toolExecution: z.literal(true),
  userCancel: z.literal(true),
  desktopNormalExit: z.literal(true),
  stdinEof: z.literal(true),
  officialCliCrash: z.literal(true),
  shimTermination: z.literal(true),
  noOrphanProcesses: z.literal(true),
});

const linuxInteractiveScenariosSchema = interactiveScenariosSchema.extend({
  chatComposerIsolation: z.literal(true),
  chatInputEditing: z.literal(true),
  workChatWorkTransition: z.literal(true),
  piAgentSelection: z.literal(true),
  piModelSelection: z.literal(true),
  piAuthoritativeSession: z.literal(true),
  claudeCodeDiscovery: z.literal(true),
  nativeCodexSelection: z.literal(true),
});

const interactiveBase = z.object({
  schemaVersion: z.literal(PROBE_SCHEMA_VERSION),
  capturedAt: z.string(),
  desktopVersion: z.string(),
  codexCliVersion: z.string(),
  scenarios: interactiveScenariosSchema,
  privacyReview: z.string(),
});

export const desktopInteractiveEvidenceSchema = z.discriminatedUnion("platform", [
  interactiveBase.extend({
    platform: z.literal("windows"),
    windowsVersion: z.string(),
  }),
  interactiveBase.extend({
    platform: z.literal("macos"),
    macosVersion: z.string(),
    architecture: z.string().min(1),
    launchMode: z.enum(["launch-services", "direct-executable"]),
  }),
  interactiveBase.extend({
    platform: z.literal("linux"),
    linuxVersion: z.string(),
    architecture: z.literal("x64"),
    launchMode: z.literal("direct-executable"),
    scenarios: linuxInteractiveScenariosSchema,
  }),
]);

const gateReportBase = z.object({
  schemaVersion: z.literal(PROBE_SCHEMA_VERSION),
  status: z.enum(["PASS", "FAIL", "BLOCKED"]),
  recordedAt: z.string().datetime(),
  repositoryCommit: z.string(),
  desktopVersion: z.string(),
  codexCliVersion: z.string(),
  evidence: z.array(z.string()),
  completedScenarios: z.array(z.string()),
  blockedScenarios: z.array(z.string()),
  impact: z.string(),
  nextDecision: z.string(),
});

export const gateReportSchema = z.discriminatedUnion("platform", [
  gateReportBase.extend({
    platform: z.literal("windows"),
    gate: z.literal("windows-codex-transparent-proxy"),
    windowsVersion: z.string(),
  }),
  gateReportBase.extend({
    platform: z.literal("macos"),
    gate: z.literal("macos-codex-transparent-proxy"),
    macosVersion: z.string(),
    architecture: z.string().min(1),
  }),
  gateReportBase.extend({
    platform: z.literal("linux"),
    gate: z.literal("linux-codex-transparent-proxy"),
    linuxVersion: z.string(),
    architecture: z.literal("x64"),
  }),
]);

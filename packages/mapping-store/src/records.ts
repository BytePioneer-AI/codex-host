import {
  harnessIdSchema,
  hostThreadIdSchema,
  hostTurnIdSchema,
  nativeCheckpointRefSchema,
  nativeSessionRefSchema,
  nativeTurnRefSchema,
  jsonObjectSchema,
  type HarnessId,
  type HostThreadId,
  type HostTurnId,
  type NativeSessionRef,
} from "@codexhost/shared-contracts";
import { z } from "zod";

const nonBlankTextSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "Value must not be empty or whitespace",
});
const storedHostThreadIdSchema = hostThreadIdSchema.refine(
  (value) => /^[A-Za-z0-9._~-]+$/u.test(value),
  "Stored Host Thread ID is not filename-safe",
);
const isoDateSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "Timestamp must be an ISO date",
});

export const storedTurnMappingV1Schema = z
  .object({
    hostTurnId: hostTurnIdSchema,
    nativeTurnRef: nativeTurnRefSchema,
    nativeCheckpointRef: nativeCheckpointRefSchema.optional(),
  })
  .strict();

export type StoredTurnMappingV1 = z.infer<typeof storedTurnMappingV1Schema>;

export const storedThreadRecordV1Schema = z
  .object({
    formatVersion: z.literal(1),
    revision: z.number().int().positive(),
    hostThreadId: storedHostThreadIdSchema,
    createRequestId: nonBlankTextSchema.max(1_024),
    harnessId: harnessIdSchema,
    state: z.enum(["creating", "ready"]),
    nativeSessionRef: nativeSessionRefSchema.optional(),
    cwd: nonBlankTextSchema.max(16_384),
    title: z.string().max(4_096),
    archived: z.boolean(),
    transportModelId: nonBlankTextSchema.max(1_024),
    ephemeral: z.boolean(),
    historyMode: z.enum(["legacy", "paginated"]),
    forkSource: z
      .object({
        hostThreadId: hostThreadIdSchema,
        hostTurnId: hostTurnIdSchema,
      })
      .strict()
      .optional(),
    subagent: z
      .object({
        parentHostThreadId: hostThreadIdSchema,
        nativeSubagentId: nonBlankTextSchema.max(1_024),
        role: z.string().max(1_024).optional(),
      })
      .strict()
      .optional(),
    turnMappings: z.array(storedTurnMappingV1Schema),
    history: z.array(jsonObjectSchema).optional(),
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.state === "ready" && !record.nativeSessionRef) {
      context.addIssue({
        code: "custom",
        path: ["nativeSessionRef"],
        message: "Ready Thread must have a Native Session Ref",
      });
    }
    if (record.nativeSessionRef && record.nativeSessionRef.harnessId !== record.harnessId) {
      context.addIssue({
        code: "custom",
        path: ["nativeSessionRef", "harnessId"],
        message: "Native Session Harness must match the Thread Harness",
      });
    }
    const hostTurnIds = new Set<string>();
    const nativeTurnKeys = new Set<string>();
    for (const [index, mapping] of record.turnMappings.entries()) {
      if (hostTurnIds.has(mapping.hostTurnId)) {
        context.addIssue({
          code: "custom",
          path: ["turnMappings", index, "hostTurnId"],
          message: "Host Turn IDs must be unique in a Thread",
        });
      }
      hostTurnIds.add(mapping.hostTurnId);
      const nativeKey = `${mapping.nativeTurnRef.harnessId}\u0000${mapping.nativeTurnRef.nativeSessionId}\u0000${mapping.nativeTurnRef.nativeTurnKey}`;
      if (nativeTurnKeys.has(nativeKey)) {
        context.addIssue({
          code: "custom",
          path: ["turnMappings", index, "nativeTurnRef"],
          message: "Native Turn Refs must be unique in a Thread",
        });
      }
      nativeTurnKeys.add(nativeKey);
      for (const [name, ref] of [
        ["nativeTurnRef", mapping.nativeTurnRef],
        ["nativeCheckpointRef", mapping.nativeCheckpointRef],
      ] as const) {
        if (!ref) continue;
        if (ref.harnessId !== record.harnessId) {
          context.addIssue({
            code: "custom",
            path: ["turnMappings", index, name, "harnessId"],
            message: "Turn Ref Harness must match the Thread Harness",
          });
        }
        if (
          record.nativeSessionRef &&
          ref.nativeSessionId !== record.nativeSessionRef.nativeSessionId
        ) {
          context.addIssue({
            code: "custom",
            path: ["turnMappings", index, name, "nativeSessionId"],
            message: "Turn Ref Native Session must match the Thread Native Session",
          });
        }
      }
    }
  });

export type StoredThreadRecordV1 = z.infer<typeof storedThreadRecordV1Schema>;

export const delegationStatusSchema = z.enum([
  "creating",
  "running",
  "completed",
  "failed",
  "interrupted",
]);

export type DelegationStatus = z.infer<typeof delegationStatusSchema>;

export const storedDelegationRecordV1Schema = z
  .object({
    formatVersion: z.literal(1),
    revision: z.number().int().positive(),
    delegationId: storedHostThreadIdSchema,
    parentHostThreadId: hostThreadIdSchema,
    childHostThreadId: hostThreadIdSchema,
    sourceHarnessId: harnessIdSchema,
    targetHarnessId: harnessIdSchema,
    status: delegationStatusSchema,
    requestId: nonBlankTextSchema.max(1_024).optional(),
    taskDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
  })
  .strict()
  .refine((record) => record.parentHostThreadId !== record.childHostThreadId, {
    path: ["childHostThreadId"],
    message: "Delegation child Thread must differ from its parent",
  });

export type StoredDelegationRecordV1 = z.infer<typeof storedDelegationRecordV1Schema>;

export interface CreateDelegationInput {
  delegationId: HostThreadId;
  parentHostThreadId: HostThreadId;
  childHostThreadId: HostThreadId;
  sourceHarnessId: HarnessId;
  targetHarnessId: HarnessId;
  status?: DelegationStatus;
  requestId?: string;
  taskDigest: string;
}

export interface FindRecentDelegationInput {
  parentHostThreadId: HostThreadId;
  targetHarnessId: HarnessId;
  taskDigest: string;
  since: Date;
}

export interface CreateProvisionalThreadInput {
  hostThreadId: HostThreadId;
  createRequestId: string;
  harnessId: HarnessId;
  cwd: string;
  title?: string;
  transportModelId: string;
  ephemeral: boolean;
  historyMode: "legacy" | "paginated";
  forkSource?: { hostThreadId: HostThreadId; hostTurnId: HostTurnId };
  subagent?: {
    parentHostThreadId: HostThreadId;
    nativeSubagentId: string;
    role?: string;
  };
}

export interface CommitReadyThreadInput {
  hostThreadId: HostThreadId;
  nativeSessionRef: NativeSessionRef;
  turnMappings?: StoredTurnMappingV1[];
}

export interface ReplaceReadySessionInput {
  hostThreadId: HostThreadId;
  nativeSessionRef: NativeSessionRef;
  turnMappings: StoredTurnMappingV1[];
  forkSource: { hostThreadId: HostThreadId; hostTurnId: HostTurnId };
}

export interface ReplaceReadySessionAfterLastTurnInput {
  hostThreadId: HostThreadId;
  nativeSessionRef: NativeSessionRef;
  turnMappings: StoredTurnMappingV1[];
}

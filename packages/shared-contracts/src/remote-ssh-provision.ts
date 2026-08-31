import { z } from "zod";

const REMOTE_SSH_HOST_PREFIXES = [
  "remote-ssh-discovered:",
  "remote-ssh-codex-managed:",
  "remote-ssh:",
] as const;

export function sshTargetFromRemoteHostId(hostId: string): string | null {
  for (const prefix of REMOTE_SSH_HOST_PREFIXES) {
    if (!hostId.startsWith(prefix)) continue;
    const raw = hostId.slice(prefix.length);
    if (raw.length === 0) return null;
    try {
      const decoded = decodeURIComponent(raw);
      return decoded.trim().length > 0 ? decoded : null;
    } catch {
      return raw;
    }
  }
  return null;
}

export function isRemoteSshHostId(hostId: string): boolean {
  return sshTargetFromRemoteHostId(hostId) !== null;
}

export const remoteSshOccupancyKindSchema = z.enum([
  "idle",
  "official-remote-control",
  "unknown-busy",
  "grok-missing",
]);

export type RemoteSshOccupancyKind = z.infer<typeof remoteSshOccupancyKindSchema>;

export function classifyRemoteSshOccupancy(input: {
  grokPath: string | null;
  ownerCommand: string | null;
}): RemoteSshOccupancyKind {
  const ownerCommand = input.ownerCommand ?? "";
  if (
    ownerCommand.includes("app-server") &&
    ownerCommand.includes("--remote-control") &&
    ownerCommand.includes("--listen")
  ) {
    return "official-remote-control";
  }
  if (ownerCommand.trim().length > 0) return "unknown-busy";
  if (!input.grokPath) return "grok-missing";
  return "idle";
}

export const remoteSshPreflightParamsSchema = z
  .object({
    hostId: z.string().min(1),
    sshTarget: z.string().min(1).optional(),
  })
  .strict();

export type RemoteSshPreflightParams = z.infer<typeof remoteSshPreflightParamsSchema>;

export const remoteSshPreflightResultSchema = z
  .object({
    sshTarget: z.string().min(1),
    kind: remoteSshOccupancyKindSchema,
    grokPath: z.string().nullable(),
    ownerCommand: z.string().nullable(),
    message: z.string().min(1),
  })
  .strict();

export type RemoteSshPreflightResult = z.infer<typeof remoteSshPreflightResultSchema>;

export const remoteSshProvisionParamsSchema = z
  .object({
    hostId: z.string().min(1),
    sshTarget: z.string().min(1).optional(),
    replaceOfficialDaemon: z.boolean().optional(),
  })
  .strict();

export type RemoteSshProvisionParams = z.infer<typeof remoteSshProvisionParamsSchema>;

export const remoteSshProvisionResultSchema = z
  .object({
    ok: z.boolean(),
    sshTarget: z.string().min(1),
    kind: remoteSshOccupancyKindSchema.optional(),
    message: z.string().min(1),
    reconnectRequired: z.boolean(),
    rolledBack: z.boolean().optional(),
  })
  .strict();

export type RemoteSshProvisionResult = z.infer<typeof remoteSshProvisionResultSchema>;

export const remoteSshProvisionLogNotificationSchema = z
  .object({
    hostId: z.string().min(1),
    chunk: z.string(),
  })
  .strict();

export type RemoteSshProvisionLogNotification = z.infer<
  typeof remoteSshProvisionLogNotificationSchema
>;

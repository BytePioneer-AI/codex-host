import { z } from "zod";

export const RUNTIME_STATUS_METHOD = "codexhost/runtime/status";
export const REMOTE_UPDATE_METHOD = "codexhost/remote/update";
export const remoteUpdatePhaseSchema = z.enum([
  "idle",
  "installing",
  "restarting",
  "succeeded",
  "failed",
]);
export const runtimeStatusSchema = z.object({
  runningVersion: z.string().nullable(),
  installedVersion: z.string().nullable(),
  restartRequired: z.boolean(),
  remote: z.boolean(),
  updateSupported: z.boolean(),
  update: z.object({
    phase: remoteUpdatePhaseSchema,
    targetVersion: z.string().nullable(),
    error: z.string().nullable(),
  }),
});
export const remoteUpdateParamsSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
  })
  .strict();
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;
export type RemoteUpdateParams = z.infer<typeof remoteUpdateParamsSchema>;

export const REMOTE_SSH_SETUP_METHOD = "codexhost/remote/ssh-setup";
export const remoteSshSetupParamsSchema = z
  .object({
    hostname: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => !value.startsWith("-") && !/\s/u.test(value)),
    port: z.number().int().min(1).max(65535).nullable(),
    identity: z.string().max(4096).nullable(),
    action: z.enum(["inspect", "install", "repair"]),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/u)
      .nullable(),
  })
  .strict();
export const remoteSshSetupResultSchema = z
  .object({ state: z.enum(["installed", "not-installed"]) })
  .strict();
export type RemoteSshSetupParams = z.infer<typeof remoteSshSetupParamsSchema>;
export type RemoteSshSetupResult = z.infer<typeof remoteSshSetupResultSchema>;

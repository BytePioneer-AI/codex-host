import { z } from "zod";

export const DELEGATION_CAPACITY_SETTINGS_METHOD = "codexhost/settings/delegation-capacity/set";
export const DELEGATION_CAPACITY_MAX_RUNNING_MIN = 1;
export const DELEGATION_CAPACITY_MAX_RUNNING_MAX = 32;

export const delegationCapacitySettingsSchema = z.strictObject({
  enabled: z.boolean(),
  maxRunning: z
    .number()
    .int()
    .min(DELEGATION_CAPACITY_MAX_RUNNING_MIN)
    .max(DELEGATION_CAPACITY_MAX_RUNNING_MAX),
});

export type DelegationCapacitySettings = z.infer<typeof delegationCapacitySettingsSchema>;

export const DEFAULT_DELEGATION_CAPACITY_SETTINGS: Readonly<DelegationCapacitySettings> =
  Object.freeze({
    enabled: false,
    maxRunning: 4,
  });

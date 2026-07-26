import { z } from "zod";

const opaqueIdSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "Identifier must not be empty or whitespace",
});

export const harnessIdSchema = opaqueIdSchema.brand<"HarnessId">();
export type HarnessId = z.infer<typeof harnessIdSchema>;

export const hostThreadIdSchema = opaqueIdSchema.brand<"HostThreadId">();
export type HostThreadId = z.infer<typeof hostThreadIdSchema>;

export const hostTurnIdSchema = opaqueIdSchema.brand<"HostTurnId">();
export type HostTurnId = z.infer<typeof hostTurnIdSchema>;

export const hostItemIdSchema = opaqueIdSchema.brand<"HostItemId">();
export type HostItemId = z.infer<typeof hostItemIdSchema>;

export const hostInteractionIdSchema = opaqueIdSchema.brand<"HostInteractionId">();
export type HostInteractionId = z.infer<typeof hostInteractionIdSchema>;

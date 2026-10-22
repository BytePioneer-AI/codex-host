import { z } from "zod";

export const GROK_COMPUTER_USE_GET_METHOD = "codexhost/harness/grok-computer-use/get";
export const GROK_COMPUTER_USE_SET_METHOD = "codexhost/harness/grok-computer-use/set";

export const grokComputerUseGetSchema = z.object({}).strict();
export const grokComputerUseSetSchema = z
  .object({
    enabled: z.boolean().optional(),
    browser: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.enabled !== undefined || value.browser !== undefined, {
    message: "Expected enabled or browser",
  });
export const grokComputerUseSettingsSchema = z
  .object({
    enabled: z.boolean(),
    available: z.boolean(),
    unavailableReason: z.string().min(1).max(500).optional(),
    browser: z.boolean().optional(),
    browserFilesPresent: z.boolean().optional(),
    browserAvailable: z.boolean().optional(),
    browserUnavailableReason: z.string().min(1).max(500).optional(),
    applyFailed: z.boolean().optional(),
    applyError: z.string().min(1).max(500).optional(),
  })
  .strict();

export type GrokComputerUseSettings = z.infer<typeof grokComputerUseSettingsSchema>;
export type GrokComputerUseSet = z.infer<typeof grokComputerUseSetSchema>;

import { z } from "zod";

export const WORKBENCH_GET_METHOD = "codexhost/workbench/get";
export const WORKBENCH_SET_METHOD = "codexhost/workbench/set";
export const WORKBENCH_ENTRY_LIMIT = 100;

export const workbenchEntrySchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/u),
  category: z.enum(["knowledge", "projects", "chats"]),
  name: z.string().trim().min(1).max(80),
  icon: z.string().trim().min(1).max(16),
  url: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .url()
    .refine((value) => {
      return (
        /^https?:\/\/[^/?#@\\]+(?:[/?#]|$)/iu.test(value) && !/[\u0000-\u0020\u007f\\]/u.test(value)
      );
    }, "Use an HTTP(S) link without embedded credentials"),
});

export const workbenchConfigSchema = z
  .strictObject({
    version: z.literal(1),
    entries: z.array(workbenchEntrySchema).max(WORKBENCH_ENTRY_LIMIT),
  })
  .refine(
    (value) => new Set(value.entries.map((entry) => entry.id)).size === value.entries.length,
    "Entry IDs must be unique",
  );
export const workbenchGetParamsSchema = z.strictObject({});
export type WorkbenchConfig = z.infer<typeof workbenchConfigSchema>;
export type WorkbenchEntry = z.infer<typeof workbenchEntrySchema>;

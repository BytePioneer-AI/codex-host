import { z } from "zod";
import { harnessLocalizedTextSchema } from "./harness-presentation.js";
import { harnessIdSchema } from "./ids.js";

export const HARNESS_INSTALLATION_METHOD = "codexhost/harness/installation";
/** npm global install allows 10 minutes; this bound covers that plus version readback. */
export const HARNESS_INSTALLATION_MUTATION_TIMEOUT_MS = 660_000;
export const HARNESS_INSTALLATION_START_METHOD = "codexhost/harness/installation/start";
export const HARNESS_INSTALLATION_STATUS_METHOD = "codexhost/harness/installation/status";
export const harnessInstallationParamsSchema = z
  .object({
    harnessId: harnessIdSchema,
    action: z.enum(["check", "update", "install"]),
  })
  .strict();

export function harnessInstallationRequestTimeoutMs(
  method: string,
  params: unknown,
): number | undefined {
  if (method !== HARNESS_INSTALLATION_METHOD) return;
  const parsed = harnessInstallationParamsSchema.safeParse(params);
  if (!parsed.success || parsed.data.action === "check") return;
  return HARNESS_INSTALLATION_MUTATION_TIMEOUT_MS;
}
export const harnessInstallationStateSchema = z
  .object({
    currentVersion: z.string().min(1).max(128),
    latestVersion: z.string().min(1).max(128),
    updateAvailable: z.boolean(),
    canUpdate: z.boolean(),
    /** Defaults to CLI; some Harnesses ship only inside a desktop application. */
    versionKind: z.enum(["cli", "application"]).optional(),
    /** Official download opened by the user; does not imply an automatic installation. */
    manualUpdateUrl: z
      .url()
      .max(2048)
      .refine(
        (value) => /^https:\/\/[^/?#@]+(?:[/?#]|$)/iu.test(value),
        "Manual updates require a credential-free HTTPS URL",
      )
      .optional(),
    // Adapter-owned diagnostic text; UI uses messageCode rather than displaying it verbatim.
    message: z.string().max(2048).optional(),
    messageCode: z.string().min(1).max(128).optional(),
    /** Safe plugin-owned explanation, distinct from raw diagnostic message. */
    notice: harnessLocalizedTextSchema.optional(),
    latestVersionKind: z.enum(["unknown", "tracking-branch"]).optional(),
  })
  .strict();
export type HarnessInstallationParams = z.infer<typeof harnessInstallationParamsSchema>;
export type HarnessInstallationState = z.infer<typeof harnessInstallationStateSchema>;

export const harnessInstallationTaskParamsSchema = z.object({ taskId: z.string().uuid() }).strict();
export const harnessInstallationTaskSchema = z.discriminatedUnion("status", [
  z.object({ taskId: z.string().uuid(), status: z.literal("running") }).strict(),
  z
    .object({
      taskId: z.string().uuid(),
      status: z.literal("succeeded"),
      result: harnessInstallationStateSchema,
    })
    .strict(),
  z
    .object({
      taskId: z.string().uuid(),
      status: z.literal("failed"),
      error: z.object({ code: z.number().int(), message: z.string().min(1).max(2048) }).strict(),
    })
    .strict(),
]);
export type HarnessInstallationTask = z.infer<typeof harnessInstallationTaskSchema>;

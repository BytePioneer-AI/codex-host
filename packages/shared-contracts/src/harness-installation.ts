import { z } from "zod";
import { harnessLocalizedTextSchema } from "./harness-presentation.js";
import { harnessIdSchema } from "./ids.js";

export const HARNESS_INSTALLATION_METHOD = "codexhost/harness/installation";
/** npm global install allows 10 minutes; this bound covers that plus version readback. */
export const HARNESS_INSTALLATION_MUTATION_TIMEOUT_MS = 660_000;
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

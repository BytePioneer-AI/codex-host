import { z } from "zod";

export const UPDATE_ERROR_MAX_LENGTH = 500;
export const UPDATE_SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export const updateSemanticVersionSchema = z.string().regex(UPDATE_SEMVER_PATTERN);
export const updateInstallationSchema = z.enum(["npm", "windows-installer", "macos-dmg"]);
export const updatePhaseSchema = z.enum([
  "prepared",
  "downloading",
  "waiting-for-exit",
  "installing",
  "restarting",
  "succeeded",
  "failed",
]);

export const updateStatusSchema = z
  .strictObject({
    version: updateSemanticVersionSchema,
    installation: updateInstallationSchema,
    phase: updatePhaseSchema,
    updatedAt: z.number().int().nonnegative(),
    downloadedBytes: z.number().int().nonnegative().optional(),
    totalBytes: z.number().int().positive().optional(),
    error: z.string().min(1).max(UPDATE_ERROR_MAX_LENGTH).nullable(),
  })
  .superRefine((status, context) => {
    if (
      status.downloadedBytes !== undefined &&
      status.totalBytes !== undefined &&
      status.downloadedBytes > status.totalBytes
    ) {
      context.addIssue({
        code: "custom",
        path: ["downloadedBytes"],
        message: "downloadedBytes must not exceed totalBytes",
      });
    }
  });

export const updateEmptyParamsSchema = z.strictObject({});

const githubReleaseNotesUrlSchema = z
  .string()
  .max(300)
  .regex(
    /^https:\/\/github\.com\/BytePioneer-AI\/codex-host\/releases\/tag\/v[0-9A-Za-z.+-]+$/u,
    "release notes URL must identify a codexhost GitHub Release",
  );

export const updateCheckResultSchema = z.strictObject({
  currentVersion: updateSemanticVersionSchema,
  installation: updateInstallationSchema.nullable(),
  latestVersion: updateSemanticVersionSchema.nullable(),
  updateAvailable: z.boolean(),
  installationAvailable: z.boolean(),
  releaseNotes: z.string().min(1).max(20_000).nullable(),
  releaseNotesUrl: githubReleaseNotesUrlSchema.nullable(),
  status: updateStatusSchema.nullable(),
  error: z.string().min(1).max(UPDATE_ERROR_MAX_LENGTH).nullable(),
});

export const updateStartResultSchema = z.strictObject({
  status: updateStatusSchema,
});

export const updateStatusResultSchema = z.strictObject({
  status: updateStatusSchema.nullable(),
});

export type UpdateInstallation = z.infer<typeof updateInstallationSchema>;
export type UpdatePhase = z.infer<typeof updatePhaseSchema>;
export type UpdateStatus = z.infer<typeof updateStatusSchema>;
export type UpdateCheckResult = z.infer<typeof updateCheckResultSchema>;
export type UpdateStartResult = z.infer<typeof updateStartResultSchema>;
export type UpdateStatusResult = z.infer<typeof updateStatusResultSchema>;

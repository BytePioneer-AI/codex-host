import { z } from "zod";

export const UPDATE_ERROR_MAX_LENGTH = 500;
export const UPDATE_SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export const updateSemanticVersionSchema = z.string().regex(UPDATE_SEMVER_PATTERN);
export const updateInstallationSchema = z.enum([
  "npm",
  "windows-installer",
  "macos-dmg",
  "linux-archive",
]);
export const updatePhaseSchema = z.enum([
  "prepared",
  "downloading",
  "waiting-for-exit",
  "installing",
  "restarting",
  "succeeded",
  "failed",
]);

export const npmDownloadProgressSchema = z
  .strictObject({
    completed: z.number().int().nonnegative(),
    total: z.number().int().positive(),
  })
  .refine((progress) => progress.completed <= progress.total, {
    path: ["completed"],
    message: "completed must not exceed total",
  });

export const updateStatusSchema = z
  .strictObject({
    version: updateSemanticVersionSchema,
    installation: updateInstallationSchema,
    phase: updatePhaseSchema,
    updatedAt: z.number().int().nonnegative(),
    downloadedBytes: z.number().int().nonnegative().optional(),
    totalBytes: z.number().int().positive().optional(),
    npmDownload: npmDownloadProgressSchema.optional(),
    error: z.string().min(1).max(UPDATE_ERROR_MAX_LENGTH).nullable(),
    serviceStopOutput: z.string().optional(),
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

export const MACOS_SIGNING_STATUS_METHOD = "codexhost/update/macos-signing/status";
export const MACOS_SIGNING_SETUP_METHOD = "codexhost/update/macos-signing/setup";
export const MACOS_SIGNING_REMOVE_METHOD = "codexhost/update/macos-signing/remove";

export const macosLocalSigningStatusSchema = z.strictObject({
  supported: z.boolean(),
  enabled: z.boolean(),
  certificatePresent: z.boolean(),
  appSignedWithLocalCert: z.boolean(),
  appPath: z.string().min(1).nullable(),
  certificateName: z.string().min(1),
  certificateSha1: z
    .string()
    .regex(/^[0-9A-Fa-f]{40}$/u)
    .nullable(),
});

export type UpdateInstallation = z.infer<typeof updateInstallationSchema>;
export type UpdatePhase = z.infer<typeof updatePhaseSchema>;
export type UpdateStatus = z.infer<typeof updateStatusSchema>;
export type UpdateCheckResult = z.infer<typeof updateCheckResultSchema>;
export type UpdateStartResult = z.infer<typeof updateStartResultSchema>;
export type UpdateStatusResult = z.infer<typeof updateStatusResultSchema>;
export type MacOsLocalSigningStatus = z.infer<typeof macosLocalSigningStatusSchema>;

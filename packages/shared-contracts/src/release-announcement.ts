import { z } from "zod";

import { updateSemanticVersionSchema } from "./updates.js";

export const RELEASE_ANNOUNCEMENT_GET_METHOD = "codexhost/announcement/get";
export const RELEASE_ANNOUNCEMENT_ACKNOWLEDGE_METHOD = "codexhost/announcement/acknowledge";
export const RELEASE_ANNOUNCEMENT_MAX_THEMES = 12;

export const releaseAnnouncementThemeSchema = z.strictObject({
  icon: z.string().min(1).max(16).optional(),
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(1_200),
  contributors: z.array(z.string().min(1).max(39)).max(30),
});

/** One language of a release announcement: a summary sentence and its themes. */
export const releaseAnnouncementContentSchema = z.strictObject({
  summary: z.string().min(1).max(600).optional(),
  themes: z.array(releaseAnnouncementThemeSchema).min(1).max(RELEASE_ANNOUNCEMENT_MAX_THEMES),
});

/** The announcement for the running codexhost version, parsed from its GitHub Release. */
export const releaseAnnouncementSchema = z
  .strictObject({
    version: updateSemanticVersionSchema,
    publishedAt: z.iso.datetime(),
    url: z
      .string()
      .max(300)
      .regex(
        /^https:\/\/github\.com\/BytePioneer-AI\/codex-host\/releases\/tag\/v[0-9A-Za-z.+-]+$/u,
      ),
    zh: releaseAnnouncementContentSchema.nullable(),
    en: releaseAnnouncementContentSchema.nullable(),
  })
  .refine((value) => value.zh !== null || value.en !== null, {
    message: "an announcement needs at least one language",
  });

/** `manual` reads the announcement even after it was acknowledged (Settings entry). */
export const releaseAnnouncementGetParamsSchema = z.strictObject({
  manual: z.boolean().optional(),
});

export const releaseAnnouncementGetResultSchema = z.strictObject({
  announcement: releaseAnnouncementSchema.nullable(),
  unread: z.boolean(),
});

export const releaseAnnouncementAcknowledgeParamsSchema = z.strictObject({
  version: updateSemanticVersionSchema,
});

export type ReleaseAnnouncementTheme = z.infer<typeof releaseAnnouncementThemeSchema>;
export type ReleaseAnnouncementContent = z.infer<typeof releaseAnnouncementContentSchema>;
export type ReleaseAnnouncement = z.infer<typeof releaseAnnouncementSchema>;
export type ReleaseAnnouncementGetParams = z.infer<typeof releaseAnnouncementGetParamsSchema>;
export type ReleaseAnnouncementGetResult = z.infer<typeof releaseAnnouncementGetResultSchema>;
export type ReleaseAnnouncementAcknowledgeParams = z.infer<
  typeof releaseAnnouncementAcknowledgeParamsSchema
>;

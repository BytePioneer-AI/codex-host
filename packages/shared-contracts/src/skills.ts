import { z } from "zod";

/**
 * Read-only machine-wide skill catalog: every skill directory the Harnesses that expose local
 * skills keep on this machine, plus the Host-level cross-Harness shared directory. Read locally
 * without starting a process or opening a Session.
 */
export const HARNESS_SKILLS_METHOD = "codexhost/skills/list";

export const HARNESS_SKILLS_RANGES = ["harness", "shared"] as const;
export type HarnessSkillsOrigin = (typeof HARNESS_SKILLS_RANGES)[number];

/** Bounded display text: trims control characters and enforces a hard length ceiling. */
const label = z
  .string()
  .max(512)
  .transform((value) => value.replaceAll(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "").trim())
  .pipe(z.string().min(1).max(512));

/** A skill's display name; defaults to its directory name when the manifest omits `name`. */
export const harnessSkillNameSchema = label;
export const harnessSkillCategorySchema = label;
export const harnessSkillSourceLabelSchema = label;

/**
 * One line of human intent. Truncated on a character boundary, never on a byte boundary, when a
 * manifest carries more than the UI shows.
 */
export const harnessSkillDescriptionSchema = z
  .string()
  .max(4096)
  .transform((value) => value.replaceAll(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "").trim())
  .pipe(z.string().max(4096));

/** How the UI may change a skill's state, when the Harness exposes a switch at all. */
export const HARNESS_SKILL_TOGGLES = ["config", "archive"] as const;
export type HarnessSkillToggle = (typeof HARNESS_SKILL_TOGGLES)[number];

export const harnessSkillEntrySchema = z.strictObject({
  /** Skill name: frontmatter `name`, else the directory name. */
  name: harnessSkillNameSchema,
  description: harnessSkillDescriptionSchema,
  /** Category from the manifest frontmatter `category`, else the parent directory name; absent when the skill sits at the root with no frontmatter category. */
  category: harnessSkillCategorySchema.optional(),
  /** Absolute directory the SKILL.md lives in, as recorded on disk. */
  path: z.string().min(1).max(4096),
  /** Whether the Harness loads this skill now. False for config-disabled and archived skills. */
  enabled: z.boolean().default(true),
  /** Parked in an archive/hidden directory: not loaded, and the Harness can restore it. */
  archived: z.boolean().default(false),
  /**
   * The switch the UI shows: `config` toggles the skill in place, `archive` restores it from the
   * archive directory. Absent means the Harness has no switch, so the page stays read-only.
   */
  toggle: z.enum(HARNESS_SKILL_TOGGLES).optional(),
});

export const harnessSkillGroupSchema = z.strictObject({
  harness: harnessSkillNameSchema,
  /** Adapter-provided display label, e.g. a localized-friendly product name. */
  sourceLabel: harnessSkillSourceLabelSchema.optional(),
  origin: z.enum(HARNESS_SKILLS_RANGES),
  skills: z.array(harnessSkillEntrySchema).max(4096),
  /** Read failures per directory; the page shows them instead of hiding the harness. */
  failures: z
    .array(z.strictObject({ path: z.string().max(4096), message: z.string().max(512) }))
    .max(128),
});

export const harnessSkillsListParamsSchema = z.strictObject({});
export const harnessSkillsListResultSchema = z.strictObject({
  groups: z.array(harnessSkillGroupSchema).max(128),
});

/** Turns one skill on or off; the Harness decides whether its switch is a config flip or a restore. */
export const HARNESS_SKILL_SET_ENABLED_METHOD = "codexhost/skills/setEnabled";

export const harnessSkillSetEnabledParamsSchema = z.strictObject({
  harness: harnessSkillNameSchema,
  name: harnessSkillNameSchema,
  /** Directory the user acted on; when present the Harness must re-check it still matches. */
  path: z.string().max(4096).optional(),
  enabled: z.boolean(),
});

export const harnessSkillsSetEnabledResultSchema = z.strictObject({
  ok: z.boolean(),
  /** Present when the Harness refused; shown as-is next to the switch. */
  reason: z.string().max(512).optional(),
});

/** One skill's SKILL.md, for the detail dialog. */
export const HARNESS_SKILL_CONTENT_METHOD = "codexhost/skills/content";

export const harnessSkillContentParamsSchema = z.strictObject({
  harness: harnessSkillNameSchema,
  name: harnessSkillNameSchema,
  /** Directory the user opened; when present the read must match it, not any same-name skill. */
  path: z.string().max(4096).optional(),
});

export const harnessSkillContentResultSchema = z.strictObject({
  ok: z.boolean(),
  /** Markdown source; empty when the Harness refused or the file could not be read. */
  content: z
    .string()
    .max(512 * 1024)
    .default(""),
  /** The manifest ran past the read ceiling and the tail was dropped. */
  truncated: z.boolean().default(false),
  reason: z.string().max(512).optional(),
});

/** Deletes one skill directory from disk. Destructive: the page confirms before calling it. */
export const HARNESS_SKILL_UNINSTALL_METHOD = "codexhost/skills/uninstall";

export const harnessSkillUninstallParamsSchema = z.strictObject({
  harness: harnessSkillNameSchema,
  name: harnessSkillNameSchema,
  /** Directory the user confirmed; the Harness must refuse when the scan disagrees. */
  path: z.string().max(4096).optional(),
});

export const harnessSkillUninstallResultSchema = z.strictObject({
  ok: z.boolean(),
  /** Absolute directory that was removed, echoed back so the page can report it. */
  path: z.string().max(4096).optional(),
  reason: z.string().max(512).optional(),
});

export type HarnessSkillEntry = z.infer<typeof harnessSkillEntrySchema>;
export type HarnessSkillGroup = z.infer<typeof harnessSkillGroupSchema>;
export type HarnessSkillsListParams = z.infer<typeof harnessSkillsListParamsSchema>;
export type HarnessSkillsListResult = z.infer<typeof harnessSkillsListResultSchema>;
export type HarnessSkillSetEnabledParams = z.infer<typeof harnessSkillSetEnabledParamsSchema>;
export type HarnessSkillsSetEnabledResult = z.infer<typeof harnessSkillsSetEnabledResultSchema>;
export type HarnessSkillContentParams = z.infer<typeof harnessSkillContentParamsSchema>;
export type HarnessSkillsContentResult = z.infer<typeof harnessSkillContentResultSchema>;
export type HarnessSkillUninstallParams = z.infer<typeof harnessSkillUninstallParamsSchema>;
export type HarnessSkillsUninstallResult = z.infer<typeof harnessSkillUninstallResultSchema>;

import { z } from "zod";
import { harnessPluginIdSchema } from "./harness-plugins.js";
import { harnessModelRefSchema } from "./harness-models.js";
import type { HostThreadId } from "./ids.js";

export const harnessScheduleInputSchema = z
  .object({
    harnessId: harnessPluginIdSchema,
    model: harnessModelRefSchema,
    prompt: z.string().trim().min(1).max(32_000),
    cwd: z.string().trim().max(16_384).optional(),
    frequency: z.enum(["daily", "weekly"]),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    weekday: z.number().int().min(0).max(6),
  })
  .strict();
export type HarnessScheduleInput = z.infer<typeof harnessScheduleInputSchema>;
export interface HarnessScheduleResult {
  outcome: "saved" | "failed" | "unknown";
  retryable: boolean;
  message?: string;
  threadId?: HostThreadId;
  cwd?: string;
}

export const harnessScheduleTimeSchema = harnessScheduleInputSchema.pick({
  frequency: true,
  hour: true,
  minute: true,
  weekday: true,
});
export type HarnessScheduleTime = z.infer<typeof harnessScheduleTimeSchema>;
export interface HarnessSchedule {
  id: string;
  targetThreadId: HostThreadId;
  harnessId: string;
  name: string;
  prompt: string;
  rrule: string;
  status: "ACTIVE" | "PAUSED";
}
export interface HarnessScheduleList {
  items: HarnessSchedule[];
  unresolved: number;
}
export type HarnessScheduleReference = Pick<HarnessSchedule, "id" | "targetThreadId">;
export const harnessScheduleEditSchema = z
  .object({
    name: z.string().trim().min(1).max(256).optional(),
    prompt: z.string().trim().min(1).max(32_000).optional(),
    schedule: harnessScheduleTimeSchema.optional(),
  })
  .strict();
export type HarnessScheduleEdit = z.infer<typeof harnessScheduleEditSchema>;
const weekdays = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
export function harnessScheduleRrule(input: HarnessScheduleTime): string {
  return `FREQ=${input.frequency === "daily" ? "DAILY" : "WEEKLY"};BYHOUR=${input.hour};BYMINUTE=${input.minute};BYSECOND=0${input.frequency === "weekly" ? `;BYDAY=${weekdays[input.weekday]}` : ""}`;
}
/** Only lossless single-time daily/weekly rules belong in the basic editor. */
export function parseHarnessScheduleTime(rrule: string): HarnessScheduleTime | null {
  const parts = rrule
    .replace(/^RRULE:/u, "")
    .split(";")
    .map((part) => part.split("="));
  const values = new Map<string, string>();
  for (const [key, value, extra] of parts) {
    if (
      !key ||
      !value ||
      extra !== undefined ||
      values.has(key) ||
      !["FREQ", "BYHOUR", "BYMINUTE", "BYSECOND", "BYDAY", "INTERVAL"].includes(key)
    )
      return null;
    values.set(key, value);
  }
  const freq = values.get("FREQ");
  if (
    (freq !== "DAILY" && freq !== "WEEKLY") ||
    (values.has("BYSECOND") && values.get("BYSECOND") !== "0") ||
    (values.has("INTERVAL") && values.get("INTERVAL") !== "1") ||
    (freq === "DAILY" && values.has("BYDAY"))
  )
    return null;
  // Desktop's DAILY/WEEKLY path defaults omitted seconds to zero.
  const days = freq === "WEEKLY" ? (values.get("BYDAY") ?? "").split(",") : [];
  if (
    freq === "WEEKLY" &&
    ((days.length !== 1 && days.length !== 7) ||
      new Set(days).size !== days.length ||
      days.some((day) => !weekdays.includes(day)))
  )
    return null;
  const isDaily = freq === "DAILY" || days.length === 7;
  const hour = values.get("BYHOUR") ?? "";
  const minute = values.get("BYMINUTE") ?? "";
  if (!/^\d{1,2}$/u.test(hour) || !/^\d{1,2}$/u.test(minute)) return null;
  const parsed = harnessScheduleTimeSchema.safeParse({
    frequency: isDaily ? "daily" : "weekly",
    hour: Number(hour),
    minute: Number(minute),
    weekday: isDaily ? 1 : weekdays.indexOf(days[0] ?? ""),
  });
  return parsed.success ? parsed.data : null;
}

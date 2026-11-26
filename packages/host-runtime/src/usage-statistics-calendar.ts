/** Calendar coordinates used by every range, day filter and hour bucket in one query. */
export interface UsageStatisticsCalendar {
  readonly timeZone: string;
  at(ms: number): { date: string; weekday: number; hour: number };
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const MODERN_UTC_EPOCH_MS = Date.UTC(2000, 0, 1);
const MAX_CACHED_MINUTES = 65_536;

type CalendarSlot = { date: string; weekday: number; hour: number };

function withMinuteCache(
  timeZone: string,
  compute: (ms: number) => CalendarSlot,
): UsageStatisticsCalendar {
  const byMinute = new Map<number, CalendarSlot>();
  return {
    timeZone,
    at(ms) {
      // Every modern IANA offset and DST rule aligns to whole minutes, so requests within the
      // same UTC minute share one date, weekday and hour.
      if (ms < MODERN_UTC_EPOCH_MS) return compute(ms);
      const minute = Math.floor(ms / 60_000);
      const cached = byMinute.get(minute);
      if (cached !== undefined) return cached;
      const slot = compute(ms);
      if (byMinute.size < MAX_CACHED_MINUTES) byMinute.set(minute, slot);
      return slot;
    },
  };
}

/** Omitted zones retain the Host's local calendar for callers without a display timezone. */
export function createUsageStatisticsCalendar(timeZone?: string): UsageStatisticsCalendar {
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zone = timeZone ?? localZone;
  // Preserve the local indexing fast path for the usual same-machine query.
  if (zone === localZone) {
    return withMinuteCache(zone, (ms) => {
      const date = new Date(ms);
      return {
        date: dateKey(date.getFullYear(), date.getMonth() + 1, date.getDate()),
        weekday: date.getDay(),
        hour: date.getHours(),
      };
    });
  }
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  return withMinuteCache(zone, (ms) => {
    const parts = format.formatToParts(ms);
    const part = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((value) => value.type === type)?.value);
    const year = part("year"),
      month = part("month"),
      day = part("day");
    return {
      date: dateKey(year, month, day),
      weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
      hour: part("hour"),
    };
  });
}

/** Shift calendar dates, not elapsed 24-hour periods: DST does not change a range's day count. */
export function shiftUsageDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return dateKey(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
}

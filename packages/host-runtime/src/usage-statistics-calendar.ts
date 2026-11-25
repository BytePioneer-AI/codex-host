/** Calendar coordinates used by every range, day filter and hour bucket in one query. */
export interface UsageStatisticsCalendar {
  readonly timeZone: string;
  at(ms: number): { date: string; weekday: number; hour: number };
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Omitted zones retain the Host's local calendar for callers without a display timezone. */
export function createUsageStatisticsCalendar(timeZone?: string): UsageStatisticsCalendar {
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zone = timeZone ?? localZone;
  // Preserve the local indexing fast path for the usual same-machine query.
  if (zone === localZone) {
    return {
      timeZone: zone,
      at(ms) {
        const date = new Date(ms);
        return {
          date: dateKey(date.getFullYear(), date.getMonth() + 1, date.getDate()),
          weekday: date.getDay(),
          hour: date.getHours(),
        };
      },
    };
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
  return {
    timeZone: zone,
    at(ms) {
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
    },
  };
}

/** Shift calendar dates, not elapsed 24-hour periods: DST does not change a range's day count. */
export function shiftUsageDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return dateKey(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
}

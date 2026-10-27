import { describe, expect, it } from "vitest";
import { parseHarnessScheduleTime } from "../src/harness-schedules.js";

const officialDaily = "RRULE:FREQ=WEEKLY;BYHOUR=10;BYMINUTE=15;BYDAY=SU,MO,TU,WE,TH,FR,SA";
describe("Desktop basic schedule compatibility", () => {
  it.each([
    [officialDaily, { frequency: "daily", hour: 10, minute: 15, weekday: 1 }],
    ["FREQ=DAILY;BYHOUR=9;BYMINUTE=0", { frequency: "daily", hour: 9, minute: 0, weekday: 1 }],
    [
      "RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0",
      { frequency: "weekly", hour: 9, minute: 0, weekday: 1 },
    ],
    [
      "FREQ=WEEKLY;BYDAY=FR,SA,SU,MO,TH,WE,TU;BYHOUR=10;BYMINUTE=15;BYSECOND=0;INTERVAL=1",
      { frequency: "daily", hour: 10, minute: 15, weekday: 1 },
    ],
  ] as const)("recognizes official daily/weekly shape %s", (rule, expected) => {
    expect(parseHarnessScheduleTime(rule)).toEqual(expected);
  });
  it.each([
    "SU,MO,TU,WE,TH,FR,FR",
    "SU,MO,TU,WE,TH,FR,SA,SU",
    "MO,MO",
    "SU,MO,TU,WE,TH,FR,XX",
    "SU,MO,TU,WE,TH,FR,",
    "1MO",
    "MO,FR",
  ])("does not swallow duplicate, invalid or partial weekdays: %s", (days) => {
    expect(parseHarnessScheduleTime(`FREQ=WEEKLY;BYHOUR=10;BYMINUTE=15;BYDAY=${days}`)).toBeNull();
  });
  it.each([
    officialDaily + ";BYSECOND=30",
    officialDaily + ";BYSECOND=0,30",
    officialDaily + ";COUNT=3",
    officialDaily + ";UNTIL=20271101T000000Z",
    officialDaily + ";INTERVAL=2",
    officialDaily + ";TZID=Asia/Shanghai",
    "DTSTART:20261027T101500\n" + officialDaily,
    officialDaily.replace("BYHOUR=10", "BYHOUR=10,11"),
    officialDaily.replace("BYMINUTE=15", "BYMINUTE=15,30"),
    officialDaily + ";BYDAY=MO",
  ])("keeps complex rule unsupported: %s", (rule) => {
    expect(parseHarnessScheduleTime(rule)).toBeNull();
  });
});

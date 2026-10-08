import type { StoredThreadRecordV1 } from "@codexhost/mapping-store";
import { usageSessionTitle } from "@codexhost/harness-adapter/usage-statistics";
import type { UsageStatisticsResult, UsageStatisticsSession } from "@codexhost/shared-contracts";

export type UsageSessionTitleRecord = Pick<
  StoredThreadRecordV1,
  "harnessId" | "nativeSessionRef" | "state" | "title" | "updatedAt"
>;

/** Display metadata only: never write Desktop titles into the native request parse cache. */
export function withHostSessionTitles(
  result: UsageStatisticsResult,
  records: readonly UsageSessionTitleRecord[],
): UsageStatisticsResult {
  const titles = new Map<string, { title: string; updatedAt: string }>();
  for (const record of records) {
    const ref = record.nativeSessionRef;
    const title = usageSessionTitle(record.title);
    if (record.state !== "ready" || !ref || ref.harnessId !== record.harnessId || !title)
      continue;
    const key = `${record.harnessId}\u0000${ref.nativeSessionId}`;
    const previous = titles.get(key);
    // A native Session may have been imported more than once. Prefer the latest named mapping.
    if (!previous || record.updatedAt > previous.updatedAt)
      titles.set(key, { title, updatedAt: record.updatedAt });
  }
  const decorate = (sessions: UsageStatisticsSession[]): UsageStatisticsSession[] =>
    sessions.map((session) => {
      const title = titles.get(`${session.harness}\u0000${session.sessionId}`)?.title;
      return title ? { ...session, title } : session;
    });
  return {
    ...result,
    sessions: decorate(result.sessions),
    ...(result.recentSessions ? { recentSessions: decorate(result.recentSessions) } : {}),
  };
}

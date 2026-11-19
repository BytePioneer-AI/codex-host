/** Fixed fictional rows: production icon, summary and row layout, without session bindings. */
import type { ThreadTreeStyleProps } from "../ThreadTreeStyleOptions.tsx";
import { SessionRowContent } from "./SessionRowContent.tsx";
import { ThreadTreeRing } from "./ThreadTreeRing.tsx";
import { ThreadTreeSummaryContent } from "./ThreadTreeSummaryContent.tsx";
import rowCss from "./Rows.module.css";
import treeCss from "./ThreadTreeControls.module.css";
import css from "../ThreadTreeStyle.module.css";

const SAMPLES = [
  {
    title: "threadTree.style.samplePending",
    activity: { pendingInteraction: 1, running: 0, completed: 0 },
  },
  {
    title: "threadTree.style.sampleRunning",
    activity: { pendingInteraction: 0, running: 1, completed: 0 },
  },
  {
    title: "threadTree.style.sampleUnread",
    activity: { pendingInteraction: 0, running: 0, completed: 1 },
  },
  {
    title: "threadTree.style.sampleRead",
    activity: { pendingInteraction: 0, running: 0, completed: 0 },
  },
] as const;
export function ThreadTreeStylePreview({ style, t }: Pick<ThreadTreeStyleProps, "style" | "t">) {
  return (
    <div className={css.preview} aria-hidden="true">
      {SAMPLES.map(({ title, activity }) => (
        <div key={title} className={treeCss.branch}>
          <div className={`${rowCss.sessionRow} ${css.sampleRow}`}>
            <div className={rowCss.sessionMain}>
              <SessionRowContent
                title={t(title)}
                identity={
                  <>
                    <span data-harness-id="codex" className={css.sampleIcon}>
                      <img src="/harness-icons/codex" width={14} height={14} alt="" />
                    </span>
                    {style === "ring" && <ThreadTreeRing activity={activity} />}
                  </>
                }
              />
            </div>
            {style === "summary" && (
              <div className={`${treeCss.summary} ${css.sampleSummary}`}>
                <ThreadTreeSummaryContent count={2} activity={activity} t={t} />
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

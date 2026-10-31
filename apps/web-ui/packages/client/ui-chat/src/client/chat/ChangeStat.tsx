import css from "./ChangeStat.module.css";

/** Green `+N` and red `-M` pair. */
export function ChangeStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className={css.stat}>
      <span className={css.added}>{`+${added}`}</span>
      <span className={css.removed}>{`-${removed}`}</span>
    </span>
  );
}

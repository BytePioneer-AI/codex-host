/** General -> Display row for controlling desktop shell UI zoom scale. */
import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { IconChevronDownOutlineRegular, Menu } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import { DEFAULT_ZOOM_PERCENT, type ShellZoomController } from "./shell-zoom.ts";
import css from "./ShellZoomRow.module.css";

export interface ShellZoomFace {
  zoom: ShellZoomController;
  shortcutHint: string;
}

export type ShellZoomRowProps = PropsRuntime<"settings.general.item"> &
  PropsLocale<"codexhostImport"> &
  ShellZoomFace;

export function ShellZoomRow({ zoom, shortcutHint, t }: ShellZoomRowProps): ReactNode {
  const snapshot = useSyncExternalStore(zoom.subscribe, zoom.getSnapshot);
  const [open, setOpen] = useState(false);
  const id = useId();

  const items = snapshot.ladder.map((percent) => ({
    id: String(percent),
    label:
      percent === DEFAULT_ZOOM_PERCENT
        ? t("shellZoom.defaultOption", { percent: String(percent) })
        : `${percent}%`,
  }));

  return (
    <div className={css.row} data-shell-zoom-settings>
      <div className={css.rowText}>
        <div className={css.title} id={`${id}-label`}>
          {t("shellZoom.title")}
        </div>
        <div className={css.desc}>{t("shellZoom.description", { shortcuts: shortcutHint })}</div>
      </div>
      <Menu
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        items={items}
        selectedId={String(snapshot.percent)}
        onSelect={(selectedId) => {
          // Close before changing zoom so viewport rescaling does not shift the open popup.
          setOpen(false);
          const next = Number(selectedId);
          if (Number.isFinite(next) && next !== snapshot.percent) {
            void zoom.setPercent(next);
          }
        }}
        align="end"
        portal
        anchor={
          <button
            type="button"
            className={css.selector}
            aria-labelledby={`${id}-label ${id}-value`}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => {
              setOpen((current) => !current);
            }}
          >
            <span id={`${id}-value`}>{`${snapshot.percent}%`}</span>
            <IconChevronDownOutlineRegular size={14} className={css.chevron} />
          </button>
        }
      />
    </div>
  );
}

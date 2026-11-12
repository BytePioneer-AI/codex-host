/** The General section groups feature-owned preferences by purpose. */
import { useId } from "react";
import type {
  HostObservable,
  InjectFace,
  PropsLocale,
  PropsRenderSlots,
  PropsRuntime,
} from "@deepseek-ai/dsh-client-ui-slots";
import type { SettingsKey } from "./locales.ts";
import css from "./GeneralSection.module.css";

const GROUPS: readonly { title: SettingsKey; items: readonly string[] }[] = [
  {
    title: "general.appAndNotifications",
    items: ["codexhost.notifications", "codexhost.pwa-install"],
  },
  {
    title: "general.display",
    items: ["language", "appearance", "font-size", "workspace.recent-navigation"],
  },
  {
    title: "general.interaction",
    items: ["transcript-view", "developer-tools", "shortcuts", "link-opening", "composer-enter"],
  },
];
const GROUPED_ITEMS = new Set(GROUPS.flatMap((group) => group.items));

/** Registered row identities, supplied by this section's slot ledger. */
export interface GeneralSectionInjected {
  hooks: { items: HostObservable<readonly string[]> };
}

/** Full component props: section owner share plus item render share. */
export type GeneralSectionComponentProps = PropsRuntime<"settings.section"> &
  PropsLocale<"settings"> &
  InjectFace<GeneralSectionInjected> &
  PropsRenderSlots<"settings.general.item">;

/**
 * Render the General section content column.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the section element tree.
 */
export function GeneralSection({ renderSlot, t, useItems }: GeneralSectionComponentProps) {
  const headingId = useId();
  const items = useItems((value) => value);
  const groups = GROUPS.map((group) => ({
    title: group.title,
    items: items.filter((id) => group.items.includes(id)),
  }));
  groups.push({
    title: "general.other",
    items: items.filter((id) => id !== "current-version" && !GROUPED_ITEMS.has(id)),
  });

  return (
    <div className={css.section}>
      <header className={css.heading}>
        <h2 className={css.title}>{t("general.nav")}</h2>
        <p className={css.description}>{t("general.description")}</p>
      </header>
      {groups
        .filter((group) => group.items.length > 0)
        .map((group) => (
          <section
            className={css.group}
            key={group.title}
            aria-labelledby={`${headingId}-${group.title}`}
          >
            <h3 className={css.groupTitle} id={`${headingId}-${group.title}`}>
              {t(group.title)}
            </h3>
            <div className={css.card}>
              {group.items.map((id) => (
                <div className={css.item} key={id}>
                  {renderSlot("settings.general.item", {}, { only: id })}
                </div>
              ))}
            </div>
          </section>
        ))}
      {items.includes("current-version") && (
        <div className={css.footer}>
          {renderSlot("settings.general.item", {}, { only: "current-version" })}
        </div>
      )}
    </div>
  );
}

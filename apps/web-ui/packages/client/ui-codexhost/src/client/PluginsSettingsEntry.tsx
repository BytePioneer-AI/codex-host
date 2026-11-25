import { Button, usePhoneSidebar } from "@deepseek-ai/dsh-client-ui-primitives";
import type { SettingsSectionOwnerProps } from "@deepseek-ai/dsh-client-ui-settings/client";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import css from "./WebExtensionsSection.module.css";

/** Settings keeps its existing navigation id but hands off to the workspace. */
export function PluginsSettingsEntry({
  t,
  close,
  openWorkspace,
}: PropsLocale<"codexhostImport"> & SettingsSectionOwnerProps & { openWorkspace: () => void }) {
  const drawer = usePhoneSidebar();
  return (
    <section className={css.page}>
      <h2 className={css.title}>{t("extensions.center")}</h2>
      <p className={css.hint}>{t("extensions.workspaceHint")}</p>
      <div>
        <Button
          variant="primary"
          onClick={() => {
            close();
            drawer?.close();
            openWorkspace();
          }}
        >
          {t("extensions.openWorkspace")}
        </Button>
      </div>
    </section>
  );
}

/** General Settings entry for browser installation and platform-specific help. */
import { useId, useState, useSyncExternalStore } from "react";
import { IconDownloadOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { PwaInstall } from "@deepseek-ai/dsh-client-web";
import css from "./PwaInstallRow.module.css";

export interface PwaInstallFace {
  installation: PwaInstall;
}

export function PwaInstallRow({
  installation,
  t,
}: PropsRuntime<"settings.general.item"> & PropsLocale<"codexhostImport"> & PwaInstallFace) {
  const state = useSyncExternalStore(installation.store.subscribe, installation.store.getSnapshot);
  const [guideOpen, setGuideOpen] = useState(false);
  const guideId = useId();
  const descriptionId = useId();
  const nativePrompt = state === "available" || state === "prompting";
  const description =
    installation.guide === "insecure" && state !== "installed"
      ? t("pwa.guide.insecure")
      : state === "manual" || state === "available"
        ? null
        : t(`pwa.${state}`);

  return (
    <div className={css.section}>
      <div className={css.row}>
        <div className={css.text}>
          <div className={css.title}>{t("pwa.title")}</div>
          {description !== null && (
            <div
              id={descriptionId}
              className={css.description}
              role={state === "failed" ? "alert" : "status"}
            >
              {description}
            </div>
          )}
        </div>
        {state !== "installed" && (
          <button
            type="button"
            className={css.button}
            disabled={state === "prompting"}
            aria-busy={state === "prompting"}
            aria-describedby={description === null ? undefined : descriptionId}
            aria-expanded={nativePrompt ? undefined : guideOpen}
            aria-controls={nativePrompt ? undefined : guideId}
            onClick={() => {
              if (nativePrompt) {
                setGuideOpen(false);
                void installation.install();
              } else {
                setGuideOpen((open) => !open);
              }
            }}
          >
            <IconDownloadOutlineRegular size={16} />
            {t(nativePrompt ? "pwa.install" : "pwa.instructions")}
          </button>
        )}
      </div>
      {guideOpen && state !== "installed" && (
        <div id={guideId} className={css.guide}>
          <p>{t("pwa.guide.limitations")}</p>
          {installation.guide !== "insecure" && <p>{t(`pwa.guide.${installation.guide}`)}</p>}
        </div>
      )}
    </div>
  );
}

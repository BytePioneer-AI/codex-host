/** General → Display row for uploading a browser-local background image and adjusting its opacity. */
import {
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type ChangeEvent,
  type ReactNode,
} from "react";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import {
  ACCEPTED_WALLPAPER_MIME_TYPES,
  WALLPAPER_OPACITY_MAX,
  WALLPAPER_OPACITY_MIN,
  type WallpaperController,
} from "./wallpaper.ts";
import css from "./WallpaperRow.module.css";

export interface WallpaperFace {
  wallpaper: WallpaperController;
}

export type WallpaperRowProps = PropsRuntime<"settings.general.item"> &
  PropsLocale<"codexhostImport"> &
  WallpaperFace;

export function WallpaperRow({ wallpaper, t }: WallpaperRowProps): ReactNode {
  const snapshot = useSyncExternalStore(wallpaper.subscribe, wallpaper.getSnapshot);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sliderId = useId();

  useEffect(() => {
    return () => {
      wallpaper.setPreviewing(false);
    };
  }, [wallpaper]);

  const startPreview = (): void => {
    wallpaper.setPreviewing(true);
    const stop = (): void => {
      wallpaper.setPreviewing(false);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file === undefined) return;
    void wallpaper.upload(file);
  };

  const description =
    snapshot.error !== null
      ? t(`wallpaper.error.${snapshot.error}`)
      : snapshot.hasImage
        ? snapshot.name
          ? t("wallpaper.activeNamed", { name: snapshot.name })
          : t("wallpaper.active")
        : t("wallpaper.description");

  return (
    <div className={css.section} data-wallpaper-settings>
      <div className={css.row}>
        <div className={css.text}>
          <div className={css.title}>{t("wallpaper.title")}</div>
          <div
            className={snapshot.error === null ? css.desc : css.error}
            role={snapshot.error === null ? undefined : "alert"}
          >
            {description}
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_WALLPAPER_MIME_TYPES.join(",")}
          className={css.fileInput}
          tabIndex={-1}
          aria-hidden="true"
          data-wallpaper-file-input
          onChange={handleFileChange}
        />
        <div className={css.controls}>
          {snapshot.hasImage && snapshot.imageUrl !== null && (
            <div className={css.preview} data-wallpaper-preview aria-hidden="true">
              <div
                className={css.previewImage}
                style={{
                  backgroundImage: `url(${JSON.stringify(snapshot.imageUrl)})`,
                  opacity: snapshot.opacity / 100,
                }}
              />
            </div>
          )}
          <button
            type="button"
            className={css.button}
            disabled={snapshot.loading}
            data-wallpaper-upload
            onClick={() => {
              fileInputRef.current?.click();
            }}
          >
            {t(snapshot.hasImage ? "wallpaper.replace" : "wallpaper.upload")}
          </button>
          {snapshot.hasImage && (
            <button
              type="button"
              className={css.button}
              disabled={snapshot.loading}
              data-wallpaper-remove
              onClick={() => {
                void wallpaper.remove();
              }}
            >
              {t("wallpaper.remove")}
            </button>
          )}
        </div>
      </div>
      {snapshot.hasImage && (
        <div className={`${css.row} ${css.opacityRow}`}>
          <div className={css.text}>
            <label htmlFor={sliderId} className={css.title}>
              {t("wallpaper.opacity")}
            </label>
          </div>
          <div className={css.sliderWrap}>
            <input
              id={sliderId}
              type="range"
              min={WALLPAPER_OPACITY_MIN}
              max={WALLPAPER_OPACITY_MAX}
              step={1}
              value={snapshot.opacity}
              aria-valuetext={`${snapshot.opacity}%`}
              className={css.slider}
              style={{ "--ch-slider-progress": `${snapshot.opacity}%` } as CSSProperties}
              data-wallpaper-opacity
              onPointerDown={startPreview}
              onChange={(event) => {
                wallpaper.setOpacity(Number(event.currentTarget.value));
              }}
            />
            <span className={css.opacityValue} data-wallpaper-opacity-value>
              {snapshot.opacity}%
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

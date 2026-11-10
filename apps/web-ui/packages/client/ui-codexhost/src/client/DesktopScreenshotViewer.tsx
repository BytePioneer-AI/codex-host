import { useEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import {
  ANNOTATION_COLORS,
  drawAnnotation,
  screenToLocal,
  strokeWidthFor,
  cropBetween,
  drawCropOverlay,
  hitCrop,
  MIN_CROP,
  moveCrop,
  oppositeCorner,
  type Annotation,
  type AnnotationTool,
  type CropRect,
  type Point,
  type Rotation,
} from "./screenshot-annotation.ts";
import css from "./DesktopScreenshotViewer.module.css";

type Locale = PropsLocale<"codexhostImport">;

/**
 * The rectangle the viewer fills, in layout-viewport coordinates. While the
 * on-screen keyboard is open that is the visual viewport, including its offset
 * (iOS scrolls it inside the layout viewport); otherwise the full window,
 * because iOS can leave the visual viewport at its keyboard-shrunk size.
 */
function viewportRect(typing: boolean): { width: number; height: number; x: number; y: number } {
  const visual = window.visualViewport;
  if (typing && visual !== null)
    return {
      width: visual.width,
      height: visual.height,
      x: visual.offsetLeft,
      y: visual.offsetTop,
    };
  return { width: window.innerWidth, height: window.innerHeight, x: 0, y: 0 };
}

/** The user's last orientation choice, so reopening the viewer keeps it; the default is portrait. */
let chosenRotation: Rotation | undefined;

const HINT_SEEN_KEY = "codexhost.screenshot.zoom-hint";

const TOOLS: readonly AnnotationTool[] = ["pen", "rect", "arrow"];
/** Room kept for the control bars while marking up or cropping, so they never cover the image. */
const EDIT_TOP = 64;
const EDIT_BOTTOM = 76;
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;

/** Read the image into a decoded element the canvas can paint. */
function useBitmap(url: string): HTMLImageElement | undefined {
  const [bitmap, setBitmap] = useState<HTMLImageElement>();
  useEffect(() => {
    let live = true;
    const image = new Image();
    image.onload = () => {
      if (live) setBitmap(image);
    };
    image.src = url;
    return () => {
      live = false;
    };
  }, [url]);
  return bitmap;
}

/**
 * Full-screen screenshot viewer: rotate to landscape, mark up the image, and
 * add the result to the current conversation's draft.
 */
export function DesktopScreenshotViewer({
  src,
  t,
  onClose,
  onAttach,
  onSend,
}: {
  /** The captured image; owned by the caller and never revoked here. */
  src: string;
  onClose: () => void;
  /** Add the shown image to the draft; resolves to the rejection copy or null. */
  onAttach: (image: Blob) => string | null;
  /** Add the shown image and a one-line message, then submit; resolves to the rejection copy or null. */
  onSend: (image: Blob, message: string) => Promise<string | null>;
} & Pick<Locale, "t">) {
  const [edited, setEdited] = useState<{ url: string; blob: Blob }>();
  const current = edited?.url ?? src;
  const bitmap = useBitmap(current);
  const [rotation, setRotationState] = useState<Rotation>(chosenRotation ?? 0);
  const setRotation = (next: Rotation): void => {
    chosenRotation = next;
    setRotationState(next);
  };
  const [annotating, setAnnotating] = useState(false);
  const [cropping, setCropping] = useState(false);
  const [crop, setCrop] = useState<CropRect>();
  /** Bumped whenever an in-flight export is abandoned, so a late result is ignored. */
  const exportOp = useRef(0);
  const cropDrag = useRef<
    | { kind: "new"; from: Point; before: CropRect | undefined }
    | { kind: "resize"; anchor: Point; before: CropRect }
    | { kind: "move"; start: Point; before: CropRect }
  >();
  const [tool, setTool] = useState<AnnotationTool>("pen");
  const [color, setColor] = useState<string>(ANNOTATION_COLORS[0]);
  const [marks, setMarks] = useState<readonly Annotation[]>([]);
  const [draft, setDraft] = useState<Annotation>();
  const [error, setError] = useState<string>();
  const [chrome, setChrome] = useState(true);
  const tap = useRef<{ x: number; y: number; at: number; multi: boolean }>();
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [hint, setHint] = useState(() => {
    try {
      return localStorage.getItem(HINT_SEEN_KEY) !== "1";
    } catch {
      return false;
    }
  });

  const [typing, setTyping] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout>>();
  const messageRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState(() => viewportRect(false));
  const [area, setArea] = useState({ width: 0, height: 0 });
  const canvas = useRef<HTMLCanvasElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const resize = (): void => setView(viewportRect(typing));
    resize();
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("scroll", resize);
    // The keyboard and browser toolbars finish animating after the last event.
    const settle = setTimeout(resize, 400);
    return () => {
      clearTimeout(settle);
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("scroll", resize);
    };
  }, [typing, rotation]);
  useEffect(() => {
    const node = areaRef.current;
    if (node === null) return;
    const observer = new ResizeObserver(() =>
      setArea({ width: node.clientWidth, height: node.clientHeight }),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(
    () => () => {
      if (edited !== undefined) URL.revokeObjectURL(edited.url);
    },
    [edited],
  );
  useEffect(() => closeRef.current?.focus(), []);
  // Keep the page behind the viewer from scrolling; iOS shifts fixed layers when the keyboard opens.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
      clearTimeout(blurTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!hint) return;
    try {
      localStorage.setItem(HINT_SEEN_KEY, "1");
    } catch {
      // The hint may repeat; nothing depends on it.
    }
    const timer = setTimeout(() => setHint(false), 4500);
    return () => clearTimeout(timer);
  }, [hint]);

  const key = useRef({ annotating, cropping, onClose });
  key.current = { annotating, cropping, onClose };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (key.current.annotating) setAnnotating(false);
      else if (key.current.cropping) cancelCrop();
      else key.current.onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // Scale the image to fit the stage; the stage is rotated as a whole.
  const scale =
    bitmap === undefined || area.width === 0
      ? 0
      : Math.min(area.width / bitmap.naturalWidth, area.height / bitmap.naturalHeight);

  // Zoom and pan act on the canvas as a whole; `pan` is in the canvas's own
  // (stage-rotated) axes, relative to the area center.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ distance: number; mid: Point; zoom: number; pan: Point }>();
  const dragStart = useRef<{ at: Point; pan: Point }>();
  const viewRef = useRef({ zoom, pan, rotation });
  viewRef.current = { zoom, pan, rotation };

  /** Offset of a screen point from the area center, in the stage's own axes. */
  const localOf = (clientX: number, clientY: number): Point => {
    const rect = areaRef.current?.getBoundingClientRect();
    if (rect === undefined) return { x: 0, y: 0 };
    return screenToLocal(
      clientX - (rect.left + rect.width / 2),
      clientY - (rect.top + rect.height / 2),
      viewRef.current.rotation,
    );
  };
  const limitPan = (next: Point, level: number): Point => {
    const width = bitmap === undefined ? 0 : bitmap.naturalWidth * scale * level;
    const height = bitmap === undefined ? 0 : bitmap.naturalHeight * scale * level;
    return {
      x: Math.min(Math.max(next.x, -width / 2), width / 2),
      y: Math.min(Math.max(next.y, -height / 2), height / 2),
    };
  };
  /** Change the zoom while the point under `focus` stays put. */
  const zoomAbout = (level: number, focus: Point, from = viewRef.current): void => {
    const next = Math.min(Math.max(level, MIN_ZOOM), MAX_ZOOM);
    const ratio = next / from.zoom;
    setZoom(next);
    setPan(
      next === 1
        ? { x: 0, y: 0 }
        : limitPan(
            {
              x: focus.x - ratio * (focus.x - from.pan.x),
              y: focus.y - ratio * (focus.y - from.pan.y),
            },
            next,
          ),
    );
  };
  const resetView = (): void => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const strokeWidth = bitmap === undefined ? 4 : strokeWidthFor(bitmap.naturalWidth);
  useEffect(() => {
    const node = canvas.current;
    const context = node?.getContext("2d");
    if (node === null || !context || bitmap === undefined) return;
    node.width = bitmap.naturalWidth;
    node.height = bitmap.naturalHeight;
    context.drawImage(bitmap, 0, 0);
    for (const mark of draft === undefined ? marks : [...marks, draft])
      drawAnnotation(context, mark, strokeWidth);
    if (cropping && crop !== undefined)
      drawCropOverlay(
        context,
        crop,
        { width: node.width, height: node.height },
        1 / Math.max(zoom * scale, 0.01),
      );
  }, [bitmap, marks, draft, strokeWidth, cropping, crop, zoom, scale]);

  useEffect(() => {
    const node = areaRef.current;
    if (node === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      zoomAbout(
        viewRef.current.zoom * Math.exp(-event.deltaY * 0.0015),
        localOf(event.clientX, event.clientY),
      );
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  });

  const toImagePoint = (event: PointerEvent<HTMLElement>): Point | undefined => {
    if (bitmap === undefined || scale === 0) return undefined;
    const local = localOf(event.clientX, event.clientY);
    const x = (local.x - pan.x) / (zoom * scale) + bitmap.naturalWidth / 2;
    const y = (local.y - pan.y) / (zoom * scale) + bitmap.naturalHeight / 2;
    return {
      x: Math.min(Math.max(x, 0), bitmap.naturalWidth),
      y: Math.min(Math.max(y, 0), bitmap.naturalHeight),
    };
  };
  const beginPinch = (): void => {
    const [one, two] = [...pointers.current.values()];
    if (one === undefined || two === undefined) return;
    gesture.current = {
      distance: Math.max(1, Math.hypot(two.x - one.x, two.y - one.y)),
      mid: localOf((one.x + two.x) / 2, (one.y + two.y) / 2),
      zoom,
      pan,
    };
    dragStart.current = undefined;
    setDraft(undefined);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    // Pointer capture would redirect the click away from controls floating over the image.
    if ((event.target as HTMLElement).closest("button") !== null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 1)
      tap.current = { x: event.clientX, y: event.clientY, at: Date.now(), multi: false };
    else if (tap.current !== undefined) tap.current.multi = true;
    if (pointers.current.size === 2) {
      beginPinch();
      return;
    }
    if (pointers.current.size > 2) return;
    if (cropping) {
      const point = toImagePoint(event);
      if (point === undefined || bitmap === undefined) return;
      const before = crop;
      const grabbed =
        before === undefined ? undefined : hitCrop(before, point, 28 / (zoom * scale));
      if (before !== undefined && grabbed !== undefined && grabbed !== "inside")
        cropDrag.current = { kind: "resize", anchor: oppositeCorner(before, grabbed), before };
      else if (before !== undefined && grabbed === "inside")
        cropDrag.current = { kind: "move", start: point, before };
      else {
        cropDrag.current = { kind: "new", from: point, before };
        setCrop(
          cropBetween(point, point, { width: bitmap.naturalWidth, height: bitmap.naturalHeight }),
        );
      }
    } else if (annotating) {
      const point = toImagePoint(event);
      if (point !== undefined) setDraft({ tool, color, points: [point] });
    } else {
      dragStart.current = { at: localOf(event.clientX, event.clientY), pan };
    }
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const start = gesture.current;
    if (start !== undefined && pointers.current.size >= 2) {
      const [one, two] = [...pointers.current.values()];
      if (one === undefined || two === undefined) return;
      const distance = Math.hypot(two.x - one.x, two.y - one.y);
      const mid = localOf((one.x + two.x) / 2, (one.y + two.y) / 2);
      const next = Math.min(Math.max(start.zoom * (distance / start.distance), MIN_ZOOM), MAX_ZOOM);
      const ratio = next / start.zoom;
      setZoom(next);
      setPan(
        next === 1
          ? { x: 0, y: 0 }
          : limitPan(
              {
                x: mid.x - ratio * (start.mid.x - start.pan.x),
                y: mid.y - ratio * (start.mid.y - start.pan.y),
              },
              next,
            ),
      );
      return;
    }
    if (cropDrag.current !== undefined && bitmap !== undefined) {
      const point = toImagePoint(event);
      if (point === undefined) return;
      const bounds = { width: bitmap.naturalWidth, height: bitmap.naturalHeight };
      const drag = cropDrag.current;
      if (drag.kind === "move")
        setCrop(moveCrop(drag.before, point.x - drag.start.x, point.y - drag.start.y, bounds));
      else setCrop(cropBetween(drag.kind === "new" ? drag.from : drag.anchor, point, bounds));
    } else if (draft !== undefined) {
      const point = toImagePoint(event);
      if (point === undefined) return;
      setDraft({
        ...draft,
        points: draft.tool === "pen" ? [...draft.points, point] : [draft.points[0] ?? point, point],
      });
    } else if (dragStart.current !== undefined && zoom > 1) {
      const at = localOf(event.clientX, event.clientY);
      setPan(
        limitPan(
          {
            x: dragStart.current.pan.x + at.x - dragStart.current.at.x,
            y: dragStart.current.pan.y + at.y - dragStart.current.at.y,
          },
          zoom,
        ),
      );
    }
  };
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>, cancelled: boolean): void => {
    // Capture is also lost after a normal pointerup; only registered pointers are still active.
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    const touch = tap.current;
    if (
      !cancelled &&
      touch !== undefined &&
      !touch.multi &&
      pointers.current.size === 0 &&
      !annotating &&
      !cropping &&
      Date.now() - touch.at < 500 &&
      Math.hypot(event.clientX - touch.x, event.clientY - touch.y) < 8
    )
      setChrome((shown) => !shown);
    if (pointers.current.size === 0) tap.current = undefined;
    if (pointers.current.size < 2) gesture.current = undefined;
    dragStart.current = undefined;
    const drag = cropDrag.current;
    cropDrag.current = undefined;
    // A tap or sliver is not a selection: fall back to the previous crop.
    if (
      drag !== undefined &&
      (cancelled || (crop?.width ?? 0) < MIN_CROP || (crop?.height ?? 0) < MIN_CROP)
    )
      setCrop(drag.before);
    if (draft !== undefined && !cancelled) setMarks((list) => [...list, draft]);
    setDraft(undefined);
  };

  /** Drop every in-flight pointer and edit gesture; safe to call at any time. */
  const resetGestures = (): void => {
    pointers.current.clear();
    gesture.current = undefined;
    dragStart.current = undefined;
    cropDrag.current = undefined;
    tap.current = undefined;
    setDraft(undefined);
  };
  /** Leave keyboard mode for good before the input unmounts, which would not fire blur. */
  const endTyping = (): void => {
    clearTimeout(blurTimer.current);
    messageRef.current?.blur();
    setTyping(false);
  };
  const startEditing = (mode: "crop" | "annotate"): void => {
    endTyping();
    resetGestures();
    if (mode === "annotate") setAnnotating(true);
    else startCrop();
  };
  useEffect(() => {
    // A touch can be lost with the page (app switch, lock screen); never keep it as "down".
    const reset = (): void => resetGestures();
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", reset);
    return () => {
      window.removeEventListener("blur", reset);
      document.removeEventListener("visibilitychange", reset);
    };
  }, []);
  const startCrop = (): void => {
    if (bitmap === undefined) return;
    const { naturalWidth: width, naturalHeight: height } = bitmap;
    setCrop({ x: width * 0.1, y: height * 0.1, width: width * 0.8, height: height * 0.8 });
    setCropping(true);
    resetView();
  };
  function cancelCrop(): void {
    exportOp.current++;
    setCropping(false);
    setCrop(undefined);
  }
  const cropReady = crop !== undefined && crop.width >= MIN_CROP && crop.height >= MIN_CROP;
  const applyCrop = (): void => {
    if (bitmap === undefined || crop === undefined || !cropReady) return;
    const op = ++exportOp.current;
    const out = document.createElement("canvas");
    out.width = Math.round(crop.width);
    out.height = Math.round(crop.height);
    out
      .getContext("2d")
      ?.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, out.width, out.height);
    out.toBlob((blob) => {
      if (op !== exportOp.current) return;
      if (blob === null) {
        setError(t("desktop.annotate.failed"));
        return;
      }
      setEdited({ url: URL.createObjectURL(blob), blob });
      setMarks([]);
      cancelCrop();
      resetView();
    }, "image/png");
  };

  const finish = (): void => {
    const node = canvas.current;
    if (node === null) return;
    if (marks.length === 0) {
      setAnnotating(false);
      return;
    }
    const op = ++exportOp.current;
    node.toBlob((blob) => {
      if (op !== exportOp.current) return;
      if (blob === null) {
        setError(t("desktop.annotate.failed"));
        return;
      }
      setEdited({ url: URL.createObjectURL(blob), blob });
      setMarks([]);
      setAnnotating(false);
    }, "image/png");
  };
  const attach = async (): Promise<void> => {
    try {
      const blob = edited?.blob ?? (await (await fetch(src)).blob());
      const message = onAttach(blob);
      if (message === null) onClose();
      else setError(message);
    } catch {
      setError(t("desktop.annotate.failed"));
    }
  };

  const send = async (): Promise<void> => {
    if (sending) return;
    setSending(true);
    setError(undefined);
    try {
      const blob = edited?.blob ?? (await (await fetch(src)).blob());
      const failure = await onSend(blob, message.trim());
      if (failure === null) onClose();
      else setError(failure);
    } catch {
      setError(t("desktop.annotate.failed"));
    } finally {
      setSending(false);
    }
  };

  const save = async (): Promise<void> => {
    try {
      const blob = edited?.blob ?? (await (await fetch(src)).blob());
      const stamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\..*$/u, "");
      const file = new File([blob], `desktop-screenshot-${stamp}.png`, { type: "image/png" });
      // Phones: the share sheet offers "Save Image"; elsewhere a normal download.
      if (navigator.canShare?.({ files: [file] }) === true) {
        try {
          await navigator.share({ files: [file] });
          return;
        } catch (cause) {
          if (cause instanceof DOMException && cause.name === "AbortError") return;
        }
      }
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setError(t("desktop.save.failed"));
    }
  };

  const turned = rotation !== 0;
  const editing = annotating || cropping;
  // Centered on the rectangle the viewer fills; rotated as a whole for landscape.
  const stage = {
    left: view.x + view.width / 2,
    top: view.y + view.height / 2,
    width: turned ? view.height : view.width,
    height: turned ? view.width : view.height,
    transform: turned
      ? `translate(-50%, -50%) rotate(${String(rotation)}deg)`
      : "translate(-50%, -50%)",
  };

  return createPortal(
    <div className={css.root} role="dialog" aria-modal="true" aria-label={t("desktop.label")}>
      <div className={css.stage} style={stage}>
        <div className={`${css.bar} ${css.top} ${chrome || editing ? "" : css.hidden}`}>
          {cropping ? (
            <>
              <button type="button" className={css.text} onClick={cancelCrop}>
                {t("desktop.annotate.cancel")}
              </button>
              <button
                type="button"
                className={css.primary}
                disabled={!cropReady}
                onClick={applyCrop}
              >
                {t("desktop.annotate.done")}
              </button>
            </>
          ) : annotating ? (
            <>
              <button
                type="button"
                className={css.text}
                onClick={() => {
                  exportOp.current++;
                  setAnnotating(false);
                }}
              >
                {t("desktop.annotate.cancel")}
              </button>
              <button type="button" className={css.primary} onClick={finish}>
                {t("desktop.annotate.done")}
              </button>
            </>
          ) : (
            <>
              <button
                ref={closeRef}
                type="button"
                className={css.text}
                aria-label={t("desktop.close")}
                onClick={onClose}
              >
                ✕
              </button>
              <span className={css.spacer} />
              <button
                type="button"
                className={css.text}
                aria-pressed={turned}
                onClick={() => setRotation(turned ? 0 : 90)}
              >
                {t(turned ? "desktop.portrait" : "desktop.landscape")}
              </button>
              {turned && (
                <button
                  type="button"
                  className={css.text}
                  onClick={() => setRotation(rotation === 90 ? 270 : 90)}
                >
                  {t("desktop.flip")}
                </button>
              )}
              <button type="button" className={css.text} onClick={() => startEditing("crop")}>
                {t("desktop.crop")}
              </button>
              <button type="button" className={css.text} onClick={() => startEditing("annotate")}>
                {t("desktop.annotate")}
              </button>
            </>
          )}
        </div>
        <div
          ref={areaRef}
          className={css.area}
          style={editing ? { top: EDIT_TOP, bottom: EDIT_BOTTOM } : undefined}
          data-annotating={annotating || cropping || undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(event) => onPointerEnd(event, false)}
          onPointerCancel={(event) => onPointerEnd(event, true)}
          onLostPointerCapture={(event) => onPointerEnd(event, true)}
          onDoubleClick={resetView}
        >
          {bitmap !== undefined && scale > 0 && (
            <canvas
              ref={canvas}
              className={css.canvas}
              style={{
                width: bitmap.naturalWidth * scale,
                height: bitmap.naturalHeight * scale,
                transform: `translate(${String(pan.x)}px, ${String(pan.y)}px) scale(${String(zoom)})`,
              }}
              role="img"
              aria-label={t("desktop.primary")}
            />
          )}
          {zoom !== 1 && (
            <button type="button" className={css.zoomBadge} onClick={resetView}>
              {String(Math.round(zoom * 100))}% · {t("desktop.zoom.fit")}
            </button>
          )}
        </div>
        {hint && (
          <p className={css.hint} role="status">
            {t("desktop.hint")}
          </p>
        )}
        <div
          className={`${css.bottom} ${chrome || editing ? "" : css.hidden} ${turned ? css.wide : ""}`}
        >
          {error !== undefined && (
            <p role="alert" className={css.error}>
              {error}
            </p>
          )}
          <div className={css.bar}>
            {cropping ? (
              <>
                <span className={css.cropHint}>{t("desktop.crop.hint")}</span>
                <span className={css.spacer} />
                {crop !== undefined && (
                  <span className={css.cropSize}>
                    {String(Math.round(crop.width))} × {String(Math.round(crop.height))}
                  </span>
                )}
              </>
            ) : annotating ? (
              <>
                {TOOLS.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className={css.text}
                    aria-pressed={tool === name}
                    onClick={() => setTool(name)}
                  >
                    {t(`desktop.tool.${name}`)}
                  </button>
                ))}
                <span className={css.spacer} />
                {ANNOTATION_COLORS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={css.swatch}
                    style={{ background: value }}
                    aria-label={value}
                    aria-pressed={color === value}
                    onClick={() => setColor(value)}
                  />
                ))}
                <span className={css.spacer} />
                <button
                  type="button"
                  className={css.text}
                  disabled={marks.length === 0}
                  onClick={() => setMarks((list) => list.slice(0, -1))}
                >
                  {t("desktop.annotate.undo")}
                </button>
                <button
                  type="button"
                  className={css.text}
                  disabled={marks.length === 0}
                  onClick={() => setMarks([])}
                >
                  {t("desktop.annotate.clear")}
                </button>
              </>
            ) : (
              <>
                <div className={css.compose}>
                  <input
                    ref={messageRef}
                    className={css.message}
                    type="text"
                    value={message}
                    enterKeyHint="send"
                    placeholder={t("desktop.message.placeholder")}
                    aria-label={t("desktop.message.placeholder")}
                    onFocus={() => {
                      clearTimeout(blurTimer.current);
                      setRotationState(0);
                      setTyping(true);
                    }}
                    onBlur={() => {
                      // Blur fires on the press of another control; resizing right away would move
                      // that control out from under the finger and lose the tap.
                      clearTimeout(blurTimer.current);
                      blurTimer.current = setTimeout(() => {
                        setTyping(false);
                        window.scrollTo(0, 0);
                      }, 400);
                    }}
                    onChange={(event) => setMessage(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.nativeEvent.isComposing) void send();
                    }}
                  />
                  <button
                    type="button"
                    className={css.primary}
                    disabled={sending}
                    onClick={() => void send()}
                  >
                    {t("desktop.send")}
                  </button>
                </div>
                {edited !== undefined && (
                  <button type="button" className={css.text} onClick={() => setEdited(undefined)}>
                    {t("desktop.annotate.reset")}
                  </button>
                )}
                <span className={css.spacer} />
                <button type="button" className={css.text} onClick={() => void save()}>
                  {t("desktop.save")}
                </button>
                <button type="button" className={css.text} onClick={() => void attach()}>
                  {t("desktop.attach")}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

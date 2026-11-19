/** Pure geometry and drawing for marking up a desktop screenshot. */

/** Quarter turns the viewer can apply to read a screenshot in landscape on a portrait phone. */
export type Rotation = 0 | 90 | 270;
export type AnnotationTool = "pen" | "rect" | "arrow";

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** One mark in image pixels: a pen path, or the two corners of a rectangle/arrow. */
export interface Annotation {
  readonly tool: AnnotationTool;
  readonly color: string;
  readonly points: readonly Point[];
}

export const ANNOTATION_COLORS = ["#ff3b30", "#ffcc00", "#0a84ff"] as const;

/**
 * Express a screen-space offset from the canvas center in the canvas's own
 * (unrotated) axes. The canvas sits in a stage rotated clockwise by `rotation`.
 * @param dx - horizontal offset in screen pixels.
 * @param dy - vertical offset in screen pixels.
 * @param rotation - clockwise stage rotation.
 * @returns the offset along the canvas's own x/y axes.
 */
export function screenToLocal(dx: number, dy: number, rotation: Rotation): Point {
  if (rotation === 90) return { x: dy, y: -dx };
  if (rotation === 270) return { x: -dy, y: dx };
  return { x: dx, y: dy };
}

/**
 * Stroke width that reads the same on a 4K capture and a small window.
 * @param imageWidth - natural image width in pixels.
 */
export function strokeWidthFor(imageWidth: number): number {
  return Math.max(4, Math.round(imageWidth / 250));
}

/**
 * Paint one annotation onto an image-sized canvas context.
 * @param context - target 2D context in image pixels.
 * @param annotation - the mark to draw.
 * @param width - stroke width in image pixels.
 */
export function drawAnnotation(
  context: CanvasRenderingContext2D,
  annotation: Annotation,
  width: number,
): void {
  const [first, ...rest] = annotation.points;
  if (first === undefined) return;
  const last = rest.at(-1) ?? first;
  context.save();
  context.strokeStyle = annotation.color;
  context.fillStyle = annotation.color;
  context.lineWidth = width;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  if (annotation.tool === "pen") {
    context.moveTo(first.x, first.y);
    if (rest.length === 0) context.lineTo(first.x + 0.01, first.y);
    for (const point of rest) context.lineTo(point.x, point.y);
    context.stroke();
  } else if (annotation.tool === "rect") {
    context.rect(
      Math.min(first.x, last.x),
      Math.min(first.y, last.y),
      Math.abs(last.x - first.x),
      Math.abs(last.y - first.y),
    );
    context.stroke();
  } else {
    const angle = Math.atan2(last.y - first.y, last.x - first.x);
    const head = width * 4;
    context.moveTo(first.x, first.y);
    context.lineTo(last.x, last.y);
    context.stroke();
    context.beginPath();
    context.moveTo(last.x, last.y);
    for (const side of [-1, 1]) {
      context.lineTo(
        last.x - head * Math.cos(angle + (side * Math.PI) / 7),
        last.y - head * Math.sin(angle + (side * Math.PI) / 7),
      );
      context.moveTo(last.x, last.y);
    }
    context.stroke();
  }
  context.restore();
}

/** Crop rectangle in image pixels. */
export interface CropRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export type CropHit = "tl" | "tr" | "bl" | "br" | "inside";

/** Smallest crop edge in image pixels. */
export const MIN_CROP = 24;

/**
 * The rectangle spanned by two corner points, kept inside the image.
 * @param a - one corner.
 * @param b - the opposite corner.
 * @param bounds - image size.
 */
export function cropBetween(
  a: Point,
  b: Point,
  bounds: { readonly width: number; readonly height: number },
): CropRect {
  const left = Math.min(Math.max(Math.min(a.x, b.x), 0), bounds.width);
  const right = Math.min(Math.max(Math.max(a.x, b.x), 0), bounds.width);
  const top = Math.min(Math.max(Math.min(a.y, b.y), 0), bounds.height);
  const bottom = Math.min(Math.max(Math.max(a.y, b.y), 0), bounds.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Which part of a crop a point grabs: a corner within `tolerance`, the body, or nothing.
 * @param crop - current crop.
 * @param point - pointer in image pixels.
 * @param tolerance - corner grab radius in image pixels.
 */
export function hitCrop(crop: CropRect, point: Point, tolerance: number): CropHit | undefined {
  const corners: ReadonlyArray<readonly [CropHit, number, number]> = [
    ["tl", crop.x, crop.y],
    ["tr", crop.x + crop.width, crop.y],
    ["bl", crop.x, crop.y + crop.height],
    ["br", crop.x + crop.width, crop.y + crop.height],
  ];
  for (const [hit, x, y] of corners)
    if (Math.hypot(point.x - x, point.y - y) <= tolerance) return hit;
  const inside =
    point.x >= crop.x &&
    point.x <= crop.x + crop.width &&
    point.y >= crop.y &&
    point.y <= crop.y + crop.height;
  return inside ? "inside" : undefined;
}

/**
 * The corner opposite to a grabbed one; it stays fixed while resizing.
 * @param crop - current crop.
 * @param hit - the corner being dragged.
 */
export function oppositeCorner(crop: CropRect, hit: Exclude<CropHit, "inside">): Point {
  return {
    x: hit === "tl" || hit === "bl" ? crop.x + crop.width : crop.x,
    y: hit === "tl" || hit === "tr" ? crop.y + crop.height : crop.y,
  };
}

/**
 * Slide a crop by an offset without leaving the image.
 * @param crop - crop at drag start.
 * @param dx - horizontal offset in image pixels.
 * @param dy - vertical offset in image pixels.
 * @param bounds - image size.
 */
export function moveCrop(
  crop: CropRect,
  dx: number,
  dy: number,
  bounds: { readonly width: number; readonly height: number },
): CropRect {
  return {
    ...crop,
    x: Math.min(Math.max(crop.x + dx, 0), bounds.width - crop.width),
    y: Math.min(Math.max(crop.y + dy, 0), bounds.height - crop.height),
  };
}

/**
 * Dim everything outside the crop and mark its border and corners.
 * @param context - target 2D context in image pixels.
 * @param crop - rectangle to keep.
 * @param bounds - image size.
 * @param unit - one screen pixel in image pixels, so marks keep a constant on-screen size.
 */
export function drawCropOverlay(
  context: CanvasRenderingContext2D,
  crop: CropRect,
  bounds: { readonly width: number; readonly height: number },
  unit: number,
): void {
  context.save();
  context.fillStyle = "rgba(0, 0, 0, 0.55)";
  context.beginPath();
  context.rect(0, 0, bounds.width, bounds.height);
  context.rect(crop.x, crop.y, crop.width, crop.height);
  context.fill("evenodd");
  context.strokeStyle = "#fff";
  context.lineWidth = 2 * unit;
  context.strokeRect(crop.x, crop.y, crop.width, crop.height);
  context.fillStyle = "#fff";
  for (const [x, y] of [
    [crop.x, crop.y],
    [crop.x + crop.width, crop.y],
    [crop.x, crop.y + crop.height],
    [crop.x + crop.width, crop.y + crop.height],
  ] as const) {
    context.beginPath();
    context.arc(x, y, 7 * unit, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

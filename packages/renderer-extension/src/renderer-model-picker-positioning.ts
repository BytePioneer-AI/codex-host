const MENU_GAP = 4;
const MAIN_MENU_SIDE_OFFSET = 8;
const COLLISION_PADDING = 8;

export const RENDERER_MODEL_PICKER_MAIN_MENU_WIDTH = 260;
export const RENDERER_MODEL_PICKER_MODEL_MENU_WIDTH = 280;
export const RENDERER_MODEL_PICKER_MODEL_MENU_MAX_HEIGHT = 360;

export interface RendererMenuRect {
  left: number;
  right: number;
  top: number;
}

export interface RendererViewport {
  width: number;
  height: number;
}

export interface RendererMenuPlacement {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight?: number;
}

function clampPosition(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function fitWidth(preferredWidth: number, viewportWidth: number): number {
  return Math.max(
    COLLISION_PADDING,
    Math.min(preferredWidth, viewportWidth - COLLISION_PADDING * 2),
  );
}

function fitHeight(viewport: RendererViewport, top = COLLISION_PADDING): number {
  return Math.max(
    COLLISION_PADDING,
    Math.min(
      RENDERER_MODEL_PICKER_MODEL_MENU_MAX_HEIGHT,
      viewport.height * 0.6,
      viewport.height - top - COLLISION_PADDING,
    ),
  );
}

export function rendererModelPickerMainMenuPlacement(
  triggerRect: RendererMenuRect,
  viewport: RendererViewport,
  width = RENDERER_MODEL_PICKER_MAIN_MENU_WIDTH,
): RendererMenuPlacement {
  const maxLeft = viewport.width - COLLISION_PADDING - width;
  return {
    left: clampPosition(triggerRect.right - width, COLLISION_PADDING, maxLeft),
    width,
    bottom: Math.max(COLLISION_PADDING, viewport.height - triggerRect.top + MAIN_MENU_SIDE_OFFSET),
  };
}

export function rendererModelPickerStandaloneModelMenuPlacement(
  triggerRect: RendererMenuRect,
  viewport: RendererViewport,
): RendererMenuPlacement {
  const width = fitWidth(RENDERER_MODEL_PICKER_MODEL_MENU_WIDTH, viewport.width);
  const maxLeft = viewport.width - COLLISION_PADDING - width;
  return {
    left: clampPosition(triggerRect.right - width, COLLISION_PADDING, maxLeft),
    width,
    maxHeight: fitHeight(viewport),
    bottom: Math.max(COLLISION_PADDING, viewport.height - triggerRect.top + MAIN_MENU_SIDE_OFFSET),
  };
}

export function rendererModelPickerModelMenuPlacement(
  mainRect: RendererMenuRect,
  viewport: RendererViewport,
): RendererMenuPlacement {
  const preferredWidth = fitWidth(RENDERER_MODEL_PICKER_MODEL_MENU_WIDTH, viewport.width);
  const rightLeft = mainRect.right + MENU_GAP;
  const leftLeft = mainRect.left - MENU_GAP - preferredWidth;
  const rightAvailable = viewport.width - rightLeft - COLLISION_PADDING;
  const leftAvailable = mainRect.left - MENU_GAP - COLLISION_PADDING;

  let width: number;
  let left: number;
  if (rightAvailable >= preferredWidth) {
    width = preferredWidth;
    left = rightLeft;
  } else if (leftAvailable >= preferredWidth) {
    width = preferredWidth;
    left = leftLeft;
  } else if (rightAvailable >= leftAvailable) {
    width = Math.max(COLLISION_PADDING, rightAvailable);
    left = rightLeft;
  } else {
    width = Math.max(COLLISION_PADDING, leftAvailable);
    left = mainRect.left - MENU_GAP - width;
  }

  const top = clampPosition(mainRect.top, COLLISION_PADDING, viewport.height - COLLISION_PADDING);
  const maxHeight = fitHeight(viewport, top);

  return {
    left: clampPosition(left, COLLISION_PADDING, viewport.width - COLLISION_PADDING - width),
    top,
    width,
    maxHeight,
  };
}

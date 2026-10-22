import coloredOtterUrl from "./assets/codexhost-otter-color.svg";

/** Colored product mark for settings and console headers, separate from navigation glyphs. */
export function createRendererColoredBrandMark(ownerDocument: Document, size = 28): HTMLElement {
  const mark = ownerDocument.createElement("span");
  mark.className = "codexhost-colored-brand";
  mark.style.width = `${size}px`;
  mark.style.height = `${size}px`;
  mark.setAttribute("aria-hidden", "true");
  mark.setAttribute("data-codexhost-mark", "otter-colored");

  const image = ownerDocument.createElement("img");
  image.className = "codexhost-colored-brand__image";
  image.src = coloredOtterUrl;
  image.alt = "";
  image.draggable = false;
  mark.append(image);
  return mark;
}

/** Keep the mobile terminal and its editor above the browser's software keyboard. */
export function observeMobileTerminalViewport(root: HTMLElement): () => void {
  const window = root.ownerDocument.defaultView;
  const viewport = window?.visualViewport;
  if (!window || !viewport) return () => {};
  const previous = root.style.maxHeight;
  let frame: number | undefined;
  const measure = (): void => {
    frame = undefined;
    // Pinch zoom is not keyboard occlusion; retain native zoom and panning.
    if (Math.abs(viewport.scale - 1) > 0.01) {
      root.style.maxHeight = previous;
      return;
    }
    root.style.maxHeight = `${Math.max(0, viewport.offsetTop + viewport.height - root.getBoundingClientRect().top)}px`;
  };
  const schedule = (): void => {
    if (frame === undefined) frame = window.requestAnimationFrame(measure);
  };
  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  window.addEventListener("resize", schedule);
  measure();
  return () => {
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    viewport.removeEventListener("resize", schedule);
    viewport.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
    root.style.maxHeight = previous;
  };
}

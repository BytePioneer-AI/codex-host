const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const FALLBACK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="4" y="6" width="16" height="14" rx="4"/><path d="M12 3v3M8 12h1m6 0h1m-7 4h6" stroke-linecap="round"/></svg>';

export function createHarnessIcons(signal, unknownName) {
  const cache = new Map();
  const request = (id) => {
    if (!cache.has(id)) {
      cache.set(
        id,
        fetch(`harness?id=${encodeURIComponent(id)}`, { signal })
          .then((response) => (response.ok ? response.json() : null))
          .catch(() => null),
      );
      if (cache.size > 64) cache.delete(cache.keys().next().value);
    }
    return cache.get(id);
  };
  return (node, identity) => {
    const id = identity?.id ?? "";
    const name = identity?.name || unknownName;
    node.title = name;
    node.setAttribute("role", "img");
    node.setAttribute("aria-label", name);
    if (node.dataset.harnessId === id && node.childElementCount) return;
    node.dataset.harnessId = id;
    node.innerHTML = FALLBACK;
    const bitmap = (src, style = {}) => {
      const image = document.createElement("img");
      image.src = src;
      image.alt = "";
      image.draggable = false;
      image.addEventListener(
        "error",
        () => {
          if (node.dataset.harnessId === id) node.innerHTML = FALLBACK;
        },
        { once: true, signal },
      );
      if (style.background) image.style.background = style.background;
      if (style.borderRadius !== undefined) image.style.borderRadius = `${style.borderRadius}%`;
      if (style.paddingRatio) image.style.padding = `${style.paddingRatio * 100}%`;
      node.replaceChildren(image);
    };
    if (id === "codex") {
      bitmap("assets/codex.png");
      return;
    }
    if (!id) return;
    void request(id).then((presentation) => {
      if (signal.aborted || !node.isConnected || node.dataset.harnessId !== id || !presentation)
        return;
      const vector = presentation.iconStyle?.vector;
      if (vector) {
        const icon = document.createElementNS(SVG_NAMESPACE, "svg");
        icon.setAttribute("viewBox", vector.viewBox);
        icon.setAttribute("fill", vector.color);
        icon.setAttribute("aria-hidden", "true");
        for (const item of vector.paths) {
          const path = document.createElementNS(SVG_NAMESPACE, "path");
          path.setAttribute("d", item.d);
          if (item.fill) path.setAttribute("fill", item.fill);
          if (item.fillRule) path.setAttribute("fill-rule", item.fillRule);
          icon.append(path);
        }
        node.replaceChildren(icon);
      } else if (presentation.icon) bitmap(presentation.icon, presentation.iconStyle);
    });
  };
}

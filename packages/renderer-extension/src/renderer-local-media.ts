const VIDEO_EXTENSIONS = new Set([".m4v", ".mov", ".mp4", ".webm"]);
const UPGRADED_ATTRIBUTE = "data-codexhost-local-media";
const APP_FS_PREFIX = "app://fs/@fs";

export function isLocalVideoPath(value: string): boolean {
  const path = absoluteLocalVideoPath(value);
  return path !== null;
}

export function absoluteLocalVideoPath(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^(?:https?:|data:|blob:)/i.test(trimmed)) return null;
  const fromAppFs = pathFromAppFsUrl(trimmed);
  if (fromAppFs) return hasVideoExtension(fromAppFs) ? fromAppFs : null;
  const stripped = stripFileUrl(trimmed);
  if (stripped.includes("://") || stripped.includes("..")) return null;
  if (!isAbsolutePath(stripped) || !hasVideoExtension(stripped)) return null;
  return stripped;
}

export function codexAppFsMediaUrl(absolutePath: string): string {
  const posix = absolutePath.replaceAll("\\", "/");
  const withLeadingSlash = /^[a-zA-Z]:\//.test(posix) ? `/${posix}` : posix;
  const encoded = encodeURI(withLeadingSlash).replaceAll("#", "%23").replaceAll("?", "%3F");
  return `${APP_FS_PREFIX}${encoded.startsWith("/") ? encoded : `/${encoded}`}`;
}

export function upgradeRenderedLocalMedia(root: ParentNode = document): void {
  upgradeBrokenVideoImages(root);
  upgradeVideoPathCode(root);
}

export function installRendererLocalMediaPlayback(root: ParentNode = document): {
  dispose(): void;
} {
  const ownerDocument = nodeDocument(root);
  const target =
    ownerDocument && root === ownerDocument ? ownerDocument.documentElement : (root as Node);
  if (!ownerDocument || !target || typeof MutationObserver !== "function") {
    if (ownerDocument) upgradeRenderedLocalMedia(root);
    return { dispose() {} };
  }
  upgradeRenderedLocalMedia(root);
  const observer = new MutationObserver(() => upgradeRenderedLocalMedia(root));
  observer.observe(target, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src"],
  });
  return {
    dispose() {
      observer.disconnect();
    },
  };
}

function upgradeBrokenVideoImages(root: ParentNode): void {
  const images = root.querySelectorAll?.("img") ?? [];
  for (const image of images) {
    if (!(image instanceof Element) || image.getAttribute(UPGRADED_ATTRIBUTE) === "video") continue;
    const source = image.getAttribute("src") ?? "";
    const absolute = absoluteLocalVideoPath(source);
    if (!absolute) continue;
    const video = createVideoElement(image.ownerDocument, absolute, image.getAttribute("alt"));
    image.replaceWith(video);
  }
}

function upgradeVideoPathCode(root: ParentNode): void {
  const nodes = [
    ...(root.querySelectorAll?.("code") ?? []),
    ...(root.querySelectorAll?.('[data-markdown-copy="inline-code"]') ?? []),
  ];
  for (const node of nodes) {
    if (!(node instanceof Element) || node.getAttribute(UPGRADED_ATTRIBUTE) === "path") continue;
    const absolute = absoluteLocalVideoPath(node.textContent ?? "");
    if (!absolute) continue;
    if (hasNearbyVideo(node, absolute)) {
      node.setAttribute(UPGRADED_ATTRIBUTE, "path");
      continue;
    }
    const video = createVideoElement(node.ownerDocument, absolute, node.textContent?.trim() ?? "");
    node.setAttribute(UPGRADED_ATTRIBUTE, "path");
    node.after(video);
  }
}

function createVideoElement(
  ownerDocument: Document,
  absolutePath: string,
  label: string | null,
): HTMLVideoElement {
  const video = ownerDocument.createElement("video");
  video.setAttribute(UPGRADED_ATTRIBUTE, "video");
  video.controls = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.src = codexAppFsMediaUrl(absolutePath);
  if (label) video.setAttribute("aria-label", label);
  video.style.display = "block";
  video.style.maxWidth = "100%";
  video.style.height = "auto";
  video.style.margin = "0.5rem 0";
  return video;
}

function hasNearbyVideo(node: Element, absolutePath: string): boolean {
  const scope = node.closest("p") ?? node.parentElement;
  if (!scope) return false;
  const expected = codexAppFsMediaUrl(absolutePath);
  return [...scope.querySelectorAll("video, img")].some((media) => {
    const source = media.getAttribute("src") ?? "";
    return source === expected || absoluteLocalVideoPath(source) === absolutePath;
  });
}

function pathFromAppFsUrl(value: string): string | null {
  if (!value.startsWith(APP_FS_PREFIX)) return null;
  try {
    return decodeURI(value.slice(APP_FS_PREFIX.length));
  } catch {
    return null;
  }
}

function stripFileUrl(value: string): string {
  if (!value.toLowerCase().startsWith("file:")) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return value;
    return decodeURIComponent(url.pathname);
  } catch {
    return value.replace(/^file:\/\//i, "");
  }
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value);
}

function hasVideoExtension(value: string): boolean {
  const pathname = value.split(/[?#]/, 1)[0] ?? value;
  const dot = pathname.lastIndexOf(".");
  if (dot < 0) return false;
  return VIDEO_EXTENSIONS.has(pathname.slice(dot).toLowerCase());
}

function nodeDocument(root: ParentNode): Document | null {
  if (root instanceof Document) return root;
  if ("ownerDocument" in root && root.ownerDocument instanceof Document) return root.ownerDocument;
  return null;
}

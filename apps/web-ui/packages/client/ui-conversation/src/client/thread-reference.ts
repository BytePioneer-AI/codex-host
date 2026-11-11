/** Native Thread references shared by messages, sidebar drag, menu, and Composer. */
export const THREAD_REFERENCE_MIME = "application/x-codexhost-thread-reference";
export const THREAD_REFERENCE_SOURCE = "codexhost-thread";

/** Bare message links, excluding surrounding prose punctuation and embedded URL schemes. */
export const THREAD_LINK_PATTERN =
  /(?<![\w:/])(?:codex:\/\/threads\/|thread:\/\/)[^\s<>()\[\]`"'，。！？；：、]+(?<![.,;])/gu;

export interface ThreadReference {
  threadId: string;
  hostId: string;
  title: string;
}

export function threadReferenceOf(session: {
  id: string;
  blank: boolean;
  title?: string | undefined;
  projectionValues?: { threadReference?: { hostId: string; threadId?: string } | null } | undefined;
}): ThreadReference | undefined {
  const reference = session.projectionValues?.threadReference;
  if (session.blank || !reference?.hostId) return;
  if (
    reference.hostId !== "local" &&
    (!/^remote-(?:ssh(?:-|:)|control:)/u.test(reference.hostId) || !reference.threadId)
  )
    return;
  return {
    threadId: reference.threadId ?? session.id,
    hostId: reference.hostId,
    title:
      session.title?.replace(/[\s\u0000-\u001f\u007f]+/gu, " ").trim() || session.id.slice(0, 8),
  };
}

export function threadReferenceUri(reference: ThreadReference): string {
  const id = encodeURIComponent(reference.threadId).replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `thread://${id}?hostId=${encodeURIComponent(reference.hostId)}`;
}

/** Web Session identity for an explicit native Thread link, never inferred from titles. */
export function localThreadId(href: string): string | undefined {
  if (href.trim() !== href) return;
  const match =
    /^codex:\/\/threads\/([^/?#\s<>]+)$/u.exec(href) ??
    /^thread:\/\/([^/?#\s<>]+)\?hostId=([^&#\s]+)$/u.exec(href);
  if (match?.[1] === undefined) return;
  try {
    const id = decodeURIComponent(match[1]);
    const hostId = decodeURIComponent(match[2] ?? "local");
    if (!id || !hostId || /[\u0000-\u001f\u007f]/u.test(id + hostId)) return;
    if (hostId === "local") return id;
    if (!/^remote-(?:ssh(?:-|:)|control:)/u.test(hostId)) return;
    const bytes = new TextEncoder().encode(JSON.stringify([hostId, id]));
    return (
      "web-remote:" +
      btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "")
    );
  } catch {
    return undefined;
  }
}

export function threadReferenceInsert(reference: ThreadReference) {
  const label = reference.title.replace(/[\\`*{}[\]()#+.!_<>|~-]/gu, (char) => `\\${char}`);
  const text = `[@${label}](${threadReferenceUri(reference)})`;
  return {
    source: THREAD_REFERENCE_SOURCE,
    ref: text,
    label: reference.title,
    appearance: "session" as const,
    clipboardText: text,
  };
}

export function parseThreadReferenceDrag(text: string): ThreadReference | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object") return;
    const { threadId, hostId, title } = value as Record<string, unknown>;
    if (
      typeof threadId !== "string" ||
      !threadId ||
      typeof hostId !== "string" ||
      !hostId ||
      (hostId !== "local" && !/^remote-(?:ssh(?:-|:)|control:)/u.test(hostId)) ||
      typeof title !== "string"
    )
      return;
    return threadReferenceOf({
      id: threadId,
      blank: false,
      title,
      projectionValues: { threadReference: { hostId, threadId } },
    });
  } catch {
    return;
  }
}

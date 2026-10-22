/** Local CH Thread references shared by messages, sidebar drag, menu, and Composer. */
export const THREAD_REFERENCE_MIME = "application/x-codexhost-thread-reference";
export const THREAD_REFERENCE_SOURCE = "codexhost-thread";

export interface ThreadReference {
  threadId: string;
  hostId: "local";
  title: string;
}

export function threadReferenceOf(session: {
  id: string;
  blank: boolean;
  title?: string | undefined;
  projectionValues?: { threadReference?: { hostId: string } | null } | undefined;
}): ThreadReference | undefined {
  if (session.blank || session.projectionValues?.threadReference?.hostId !== "local") return;
  return {
    threadId: session.id,
    hostId: "local",
    title:
      session.title?.replace(/[\s\u0000-\u001f\u007f]+/gu, " ").trim() || session.id.slice(0, 8),
  };
}

export function threadReferenceUri(reference: ThreadReference): string {
  const id = encodeURIComponent(reference.threadId).replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `thread://${id}?hostId=local`;
}

/** Local Thread identities accepted from explicit message links, never inferred from titles. */
export function localThreadId(href: string): string | undefined {
  if (href.trim() !== href) return;
  const match =
    /^codex:\/\/threads\/([^/?#\s<>]+)$/u.exec(href) ??
    /^thread:\/\/([^/?#\s<>]+)\?hostId=local$/u.exec(href);
  if (match?.[1] === undefined) return;
  try {
    const id = decodeURIComponent(match[1]);
    return id && !/[\u0000-\u001f\u007f]/u.test(id) ? id : undefined;
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
      hostId !== "local" ||
      typeof title !== "string"
    )
      return;
    return threadReferenceOf({
      id: threadId,
      blank: false,
      title,
      projectionValues: { threadReference: { hostId } },
    });
  } catch {
    return;
  }
}

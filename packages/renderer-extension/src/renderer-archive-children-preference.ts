export const ARCHIVE_CHILDREN_STORAGE_KEY = "codexhost.archive-children.v1";
export const ARCHIVE_CHILDREN_CHANGE_EVENT = "codexhost:archive-children-changed";

export const ARCHIVE_CHILDREN_MODES = ["ask", "always", "never"] as const;
/** What archiving a Sidebar parent does to its unarchived Delegation and Fork children. */
export type ArchiveChildrenMode = (typeof ARCHIVE_CHILDREN_MODES)[number];

export function isArchiveChildrenMode(value: unknown): value is ArchiveChildrenMode {
  return (ARCHIVE_CHILDREN_MODES as readonly unknown[]).includes(value);
}

export function readArchiveChildrenMode(ownerWindow: Window): ArchiveChildrenMode {
  try {
    const value = ownerWindow.localStorage.getItem(ARCHIVE_CHILDREN_STORAGE_KEY);
    return isArchiveChildrenMode(value) ? value : "ask";
  } catch {
    return "ask";
  }
}

export function setArchiveChildrenMode(ownerWindow: Window, mode: ArchiveChildrenMode): void {
  try {
    if (mode === "ask") ownerWindow.localStorage.removeItem(ARCHIVE_CHILDREN_STORAGE_KEY);
    else ownerWindow.localStorage.setItem(ARCHIVE_CHILDREN_STORAGE_KEY, mode);
  } catch {
    // Storage can be unavailable; the choice then lasts for this action only.
  }
  ownerWindow.dispatchEvent(new Event(ARCHIVE_CHILDREN_CHANGE_EVENT));
}

/** Calls `listener` when the mode changes in this window or another one. */
export function subscribeArchiveChildrenMode(
  ownerWindow: Window,
  listener: () => void,
): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key === ARCHIVE_CHILDREN_STORAGE_KEY || event.key === null) listener();
  };
  ownerWindow.addEventListener(ARCHIVE_CHILDREN_CHANGE_EVENT, listener);
  ownerWindow.addEventListener("storage", onStorage);
  return () => {
    ownerWindow.removeEventListener(ARCHIVE_CHILDREN_CHANGE_EVENT, listener);
    ownerWindow.removeEventListener("storage", onStorage);
  };
}

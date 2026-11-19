import { basename, win32 } from "node:path";

/**
 * Display title for a CH thread row: the stored name, then the first prompt
 * (preview), then the project directory basename, then the thread id. Mirrors
 * the native DSH display-title fallback so a session without a title never
 * shows as "untitled" while it still has a project or identity.
 */
export function threadListTitle(row: {
  id: string;
  name?: string | null | undefined;
  preview?: string | null | undefined;
  cwd?: string | null | undefined;
}): string {
  const name = row.name?.trim();
  if (name) return name;
  const preview = row.preview?.replace(/\s+/gu, " ").trim();
  if (preview) {
    const characters = Array.from(preview);
    return characters.length > 80 ? `${characters.slice(0, 80).join("")}…` : preview;
  }
  const cwd = row.cwd ?? "";
  // Recognize drive/UNC paths even when rendering on a POSIX server. Do not
  // treat every backslash as a separator: it is valid in POSIX directory names.
  const project = /^[a-z]:[\\/]|^\\\\/iu.test(cwd) ? win32.basename(cwd) : basename(cwd);
  return project.trim() ? project : row.id;
}

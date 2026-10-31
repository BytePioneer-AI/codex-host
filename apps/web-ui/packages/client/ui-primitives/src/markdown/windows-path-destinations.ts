/** Keep backslash separators in Markdown destinations written as Windows paths. */
import type { Definition, Image, Link } from "mdast";
import type { CompileContext, Extension, Token } from "mdast-util-from-markdown";
import { decodeString } from "micromark-util-decode-string";

/** A drive letter is not a URL scheme; slash-only paths retain normal Markdown escapes. */
function isWindowsPath(raw: string): boolean {
  return (
    raw.includes("\\") &&
    !/^[a-z][a-z\d+.-]+:/iu.test(raw) &&
    (!raw.includes("/") || /\\[\p{L}\p{N}]/u.test(raw))
  );
}

function exitDestination(this: CompileContext, token: Token): void {
  const parsed = this.resume();
  const raw = this.sliceSerialize(token);
  const node = this.stack.at(-1) as Link | Image | Definition;
  // Doubling backslashes preserves separators while still decoding character references.
  node.url = isWindowsPath(raw) ? decodeString(raw.replaceAll("\\", "\\\\")) : parsed;
}

/**
 * CommonMark reads `\.` and `\_` as escapes. Windows destinations keep those
 * separators literally; other destinations retain normal Markdown decoding.
 * @returns The mdast extension for inline and reference destinations.
 */
export function windowsPathDestinations(): Extension {
  return {
    exit: {
      resourceDestinationString: exitDestination,
      definitionDestinationString: exitDestination,
    },
  };
}

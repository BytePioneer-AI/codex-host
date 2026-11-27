/** Recognize response-annotation references in Markdown's raw-source grammar. */
import type { Text } from "mdast";
import type { CompileContext, Extension as MdastExtension, Token } from "mdast-util-from-markdown";
import type { Construct, Extension, State } from "micromark-util-types";
import { decodeString } from "micromark-util-decode-string";
import { codes } from "micromark-util-symbol";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    codexAnnotation: "codexAnnotation";
    codexFileCitation: "codexFileCitation";
  }
}

/** Inline annotation reference, in the shape the renderer consumes. */
export interface CodexAnnotationNode {
  type: "codexAnnotation";
  /** String-valued index from the lexer; missing/non-string attributes are empty. */
  index: string;
  position?: Text["position"];
}

/**
 * Harness file citation, in the shape the renderer consumes: Codex replies
 * cite files they read or produced as `:codex-file-citation{path="..."}`,
 * and the renderer opens the cited path through the owner's file vocabulary.
 */
export interface CodexFileCitationNode {
  type: "codexFileCitation";
  /** Cited file path exactly as the attribute carried it (decoded once). */
  path: string;
  /** Optional citation purpose (`source`, `workspace`, …); absent when unattributed. */
  purpose?: string | undefined;
  position?: Text["position"];
}

declare module "mdast" {
  interface PhrasingContentMap {
    codexAnnotation: CodexAnnotationNode;
    codexFileCitation: CodexFileCitationNode;
  }
  interface RootContentMap {
    codexAnnotation: CodexAnnotationNode;
    codexFileCitation: CodexFileCitationNode;
  }
}

const ANNOTATION_DIRECTIVE = ":codex-annotation";
const FILE_CITATION_DIRECTIVE = ":codex-file-citation";
const SPACE = /[ \t\v\f\ufeff]/;
const NUMBER =
  /^-?(?:0[xX][\da-fA-F](?:_?[\da-fA-F])*|0[oO][0-7](?:_?[0-7])*|0[bB][01](?:_?[01])*|(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?)n?/;

type DirectiveToken = Token & {
  kind: "annotation" | "file-citation";
  index: string;
  path: string;
  purpose: string | undefined;
};
interface Directive {
  end: number;
  kind: "annotation" | "file-citation";
  index: string;
  path: string;
  purpose: string | undefined;
}

/** Decode references without treating ordinary backslashes as Markdown escapes. */
function attributeText(value: string): string {
  return decodeString(value.replaceAll("\\", "\\\\"));
}

/**
 * Desktop separates name, value-start, bare and quoted values. Whitespace after
 * `=` returns to names; inside quotes it is data. Numeric bare values are
 * stringified by its lexer before the renderer checks the canonical index.
 */
function readAttributes(
  raw: string,
): { index: string; path: string; purpose: string | undefined } | undefined {
  const namePattern = /[^\s\x00"'>/=\x00-\x1f\x7f-\x9f]+/y;
  const barePattern = /[^"\s'`=<>\x00]+/y;
  let at = 0;
  let index = "";
  let path = "";
  let purpose: string | undefined;
  while (at < raw.length) {
    if (SPACE.test(raw[at]!)) {
      at++;
      continue;
    }
    namePattern.lastIndex = at;
    const name = namePattern.exec(raw)?.[0];
    if (name === undefined) return undefined;
    at += name.length;
    if (name === "index") index = "";
    if (name === "path") path = "";
    if (name === "purpose") purpose = "";
    while (at < raw.length && SPACE.test(raw[at]!)) at++;
    if (raw[at] !== "=") continue;
    at++;

    // A separator does not consume the whitespace that starts the next name.
    if (at === raw.length || SPACE.test(raw[at]!)) continue;
    let value: string;
    const quote = raw[at];
    if (quote === '"' || quote === "'") {
      const start = ++at;
      while (at < raw.length && raw[at] !== quote) {
        if (raw[at] === "\\" && raw[at + 1] === quote) at++;
        at++;
      }
      if (at === raw.length) return undefined;
      value = attributeText(raw.slice(start, at).replaceAll("\\" + quote, quote));
      at++;
    } else {
      const tail = raw.slice(at);
      const primitive = NUMBER.exec(tail)?.[0] ?? /^(?:true|false)/.exec(tail)?.[0];
      if (primitive !== undefined) {
        value = /^(?:true|false)$/.test(primitive)
          ? primitive
          : String(Number(primitive.replace(/_|n$/g, "")));
        at += primitive.length;
      } else {
        barePattern.lastIndex = at;
        const bare = barePattern.exec(raw)?.[0];
        if (bare === undefined) return undefined;
        value = attributeText(bare);
        at += bare.length;
      }
    }
    if (name === "index") index = value;
    if (name === "path") path = value;
    if (name === "purpose") purpose = value;
  }
  return { index, path, purpose };
}

/** Consume contiguous label/attribute fragments before reading the final index. */
function readDirective(
  source: string,
  start: number,
  lastClosingBrace: number,
): Directive | undefined {
  // Longest match first: the file-citation name extends the annotation name's
  // `codex-` prefix, so the annotation name alone would swallow it.
  const matchedName =
    source.startsWith(FILE_CITATION_DIRECTIVE, start) &&
    !/[\w-]/.test(source[start + FILE_CITATION_DIRECTIVE.length] ?? "")
      ? FILE_CITATION_DIRECTIVE
      : ANNOTATION_DIRECTIVE;
  if (!source.startsWith(matchedName, start)) return undefined;
  const nameEnd = start + matchedName.length;
  if (/[\w-]/.test(source[nameEnd] ?? "")) return undefined;

  let end = nameEnd;
  let attributesStart = -1;
  let attributesEnd = -1;
  let initialLabels = 0;
  let name = matchedName.slice(1);
  while (end < source.length) {
    if (source[end] === "[") {
      let close = end + 1;
      while (close < source.length && !/[\]\r\n]/.test(source[close]!)) close++;
      if (source[close] !== "]") break;
      end = close + 1;
      if (attributesStart < 0) initialLabels++;
    } else if (source[end] === "{") {
      if (end >= lastClosingBrace) break;
      let quote: string | undefined;
      let quotedBrace = false;
      let close = end + 1;
      for (; close < source.length; close++) {
        const char = source[close];
        if (char === "\r" || char === "\n") break;
        if (quote !== undefined) {
          if (char === "\\" && source[close + 1] === quote) close++;
          else if (char === quote) quote = undefined;
          else if (char === "}") quotedBrace = true;
        } else if (char === '"' || char === "'") {
          quote = char;
        } else if (char === "}") {
          break;
        }
      }
      if (source[close] !== "}") {
        if (quotedBrace) return undefined;
        break;
      }
      const firstAttribute = attributesStart < 0;
      if (firstAttribute) attributesStart = end;
      end = close + 1;
      while (source[end] === "}") end++;
      attributesEnd = end - 1;
      // Desktop bounds an initial attribute block (with at most one label)
      // before an immediately following word. Later fragments share one span.
      if (firstAttribute && initialLabels <= 1 && /[A-Za-z]/.test(source[close + 1] ?? "")) break;
    } else if (end !== nameEnd && /[A-Za-z]/.test(source[end]!)) {
      name = /^[A-Za-z][\w-]*/.exec(source.slice(end))![0];
      end += name.length;
    } else {
      break;
    }
  }

  // The native attribute lexer reads one span, including intervening `}{` or
  // labels. In particular, `{index="1"}{index="2"}` does not reassign `index`,
  // whereas `{index="1"}{ index="2"}` does.
  const attributes =
    attributesStart < 0
      ? { index: "", path: "", purpose: undefined }
      : readAttributes(source.slice(attributesStart + 1, attributesEnd));
  if (attributes === undefined) return undefined;
  if (name !== matchedName.slice(1))
    return { end, kind: kindOf(matchedName), index: "", path: "", purpose: undefined };
  return { end, kind: kindOf(matchedName), ...attributes };
}

/** Which renderer node a matched directive name produces. */
function kindOf(directive: string): "annotation" | "file-citation" {
  return directive === FILE_CITATION_DIRECTIVE ? "file-citation" : "annotation";
}

function enterDirective(this: CompileContext, token: Token): void {
  const directive = token as DirectiveToken;
  const node =
    directive.kind === "file-citation"
      ? ({
          type: "codexFileCitation",
          path: directive.path,
          ...(directive.purpose === undefined ? {} : { purpose: directive.purpose }),
        } as CodexFileCitationNode)
      : ({ type: "codexAnnotation", index: directive.index } as CodexAnnotationNode);
  this.enter(node, token);
}

function exitDirective(this: CompileContext, token: Token): void {
  this.exit(token);
}

/**
 * Register only at the raw colon: code spans, code blocks and escaped colons
 * retain Markdown semantics. Read attributes from source offsets, not from
 * micromark codes (tabs expand to virtual spaces and line endings are virtual).
 */
export function annotationDirectiveSyntax(source: string): Extension {
  // Past the last closing brace, only name tokens are possible. This avoids
  // scanning the same unfinished tail at every directive in a streaming reply.
  const lastClosingBrace = source.lastIndexOf("}");
  const construct: Construct = {
    name: "codexAnnotation",
    tokenize(effects, ok, nok) {
      const context = this;
      const directive = readDirective(source, context.now().offset, lastClosingBrace);
      if (directive === undefined) return nok;
      const end = directive.end;
      const kind = directive.kind;
      const index = directive.index;
      const path = directive.path;
      const purpose = directive.purpose;
      return start;

      function start(code: number | null): State | undefined {
        const token = effects.enter(
          kind === "file-citation" ? "codexFileCitation" : "codexAnnotation",
        ) as DirectiveToken;
        token.kind = kind;
        token.index = index;
        token.path = path;
        token.purpose = purpose;
        return consume(code);
      }

      function consume(code: number | null): State | undefined {
        if (context.now().offset === end) {
          effects.exit(kind === "file-citation" ? "codexFileCitation" : "codexAnnotation");
          return ok(code);
        }
        effects.consume(code);
        return consume;
      }
    },
  };
  return { text: { [codes.colon]: construct } };
}

/** Convert each recognized reference to the node consumed by the renderer. */
export function annotationDirectiveMdast(): MdastExtension {
  return {
    enter: {
      codexAnnotation: enterDirective,
      codexFileCitation: enterDirective,
    },
    exit: {
      codexAnnotation: exitDirective,
      codexFileCitation: exitDirective,
    },
  };
}

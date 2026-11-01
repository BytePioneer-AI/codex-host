/**
 * Access to Codex Desktop's own Composer controller.
 *
 * Desktop's ProseMirror Composer is driven by a controller object passed to
 * React as the `composerController` prop. Its mention insertion methods create
 * native mention nodes exactly as Desktop's own `@` menu does. This is a
 * private Desktop surface: every member is feature-checked, and callers must
 * keep a fallback for when it is missing.
 */

interface NativeEditorView {
  dom: Element;
  state: {
    doc: { textBetween(from: number, to: number): string };
    schema: { nodes: Record<string, unknown> };
    selection: { from: number; to: number };
    tr: { delete(from: number, to: number): unknown; insertText(text: string): unknown };
  };
  posAtDOM(node: Node, offset: number): number;
  dispatch(transaction: unknown): void;
}

interface NativeComposerController {
  view: NativeEditorView;
  insertMentionNodeInRange(
    nodeType: unknown,
    attrs: Record<string, unknown>,
    from: number,
    to: number,
    closeSuggestion?: boolean,
  ): void;
}

const MAX_ELEMENT_DEPTH = 4;
const MAX_FIBER_DEPTH = 40;

function isController(value: unknown, editor: Element): value is NativeComposerController {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<NativeComposerController>;
  return (
    candidate.view?.dom === editor &&
    typeof candidate.view.posAtDOM === "function" &&
    typeof candidate.insertMentionNodeInRange === "function"
  );
}

function fiberOf(element: Element): unknown {
  const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"));
  return key ? (element as unknown as Record<string, unknown>)[key] : null;
}

export function findNativeComposerController(editor: Element): NativeComposerController | null {
  let element: Element | null = editor;
  for (let depth = 0; element && depth < MAX_ELEMENT_DEPTH; depth += 1) {
    let fiber = fiberOf(element) as { memoizedProps?: unknown; return?: unknown } | null;
    for (let level = 0; fiber && level < MAX_FIBER_DEPTH; level += 1) {
      const props = fiber.memoizedProps as { composerController?: unknown } | null | undefined;
      if (props && isController(props.composerController, editor)) return props.composerController;
      fiber = fiber.return as typeof fiber;
    }
    element = element.parentElement;
  }
  return null;
}

export interface NativeTextRange {
  node: Text;
  start: number;
  end: number;
  expected: string;
}

function resolveRange(
  controller: NativeComposerController,
  range: NativeTextRange,
): { from: number; to: number } | null {
  const from = controller.view.posAtDOM(range.node, range.start);
  const to = controller.view.posAtDOM(range.node, range.end);
  return controller.view.state.doc.textBetween(from, to) === range.expected ? { from, to } : null;
}

/**
 * Insert text at the editor selection through its own transaction. `build`
 * receives the character before the selection so callers can add spacing.
 */
export function insertNativeTextAtSelection(
  editor: Element,
  build: (previousCharacter: string) => string,
): boolean {
  const controller = findNativeComposerController(editor);
  if (!controller || typeof controller.view.dispatch !== "function") return false;
  try {
    const { from } = controller.view.state.selection;
    const previous = from > 0 ? controller.view.state.doc.textBetween(from - 1, from) : "";
    controller.view.dispatch(controller.view.state.tr.insertText(build(previous)));
    return true;
  } catch {
    return false;
  }
}

/** Delete the DOM text range through the editor's own transaction. */
export function deleteNativeRange(editor: Element, range: NativeTextRange): boolean {
  const controller = findNativeComposerController(editor);
  if (!controller || typeof controller.view.dispatch !== "function") return false;
  try {
    const resolved = resolveRange(controller, range);
    if (!resolved) return false;
    controller.view.dispatch(controller.view.state.tr.delete(resolved.from, resolved.to));
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace the DOM text range with a native `agentMention` node. Returns false
 * when the controller is unavailable or the range no longer holds `expected`.
 */
export function insertNativeAgentMention(
  editor: Element,
  range: NativeTextRange,
  mention: { name: string; displayName: string; path: string },
): boolean {
  const controller = findNativeComposerController(editor);
  const nodeType = controller?.view.state.schema.nodes.agentMention;
  if (!controller || !nodeType) return false;
  try {
    const resolved = resolveRange(controller, range);
    if (!resolved) return false;
    const { from, to } = resolved;
    controller.insertMentionNodeInRange(
      nodeType,
      {
        conversationId: null,
        displayName: mention.displayName,
        name: mention.name,
        path: mention.path,
      },
      from,
      to,
      true,
    );
    return true;
  } catch {
    return false;
  }
}

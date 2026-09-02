import type { CodexAccountSummary } from "@codexhost/shared-contracts";

import type { RendererAgent } from "./agent-selection-state.js";
import { RENDERER_AGENT_LABELS } from "./renderer-agent-icon.js";

const REACT_FIBER_PREFIX = "__reactFiber$";
const HARNESS_COMMAND_PREFIX = "codexhost-harness-";
const MAX_FIBER_SCAN = 20_000;
const MAX_HOOK_SCAN = 300;
const REGISTRY_COUNT_ATTRIBUTE = "data-codexhost-harness-command-registry-count";
const ACCOUNT_COUNT_ATTRIBUTE = "data-codexhost-harness-account-count";

export interface HarnessMentionMatch {
  query: string;
  start: number;
  end: number;
}

export interface HarnessMentionCandidate {
  accountId?: string;
  agent: RendererAgent;
  description: string;
  id: string;
  insertion: string;
  title: string;
}

export interface NativeComposerCommand {
  description: string;
  enabled?: boolean;
  id: string;
  onSelect?: () => Promise<void> | void;
  requiresEmptyComposer: boolean;
  submenu?: unknown;
  title: string;
  triggers?: string[];
}

interface ReactHook {
  baseState?: unknown;
  memoizedState?: unknown;
  next?: ReactHook | null;
}

interface ReactFiber {
  alternate?: ReactFiber | null;
  child?: ReactFiber | null;
  memoizedProps?: unknown;
  memoizedState?: ReactHook | null;
  pendingProps?: unknown;
  return?: ReactFiber | null;
  sibling?: ReactFiber | null;
}

interface NativeContextualSuggestions {
  onRequestClose(): void;
}

export interface RendererHarnessMentionControl {
  setAgents(agents: readonly RendererAgent[]): void;
  setCodexAccounts(accounts: readonly CodexAccountSummary[]): void;
  handleKeyDown(event: KeyboardEvent): boolean;
  refresh(): void;
  close(): void;
  dispose(): void;
}

export function harnessMentionMatch(textBeforeCaret: string): HarnessMentionMatch | null {
  const match = /(^|[^A-Za-z0-9._%+-])@([a-z-]*)$/iu.exec(textBeforeCaret);
  if (!match) return null;
  const query = (match[2] ?? "").toLowerCase();
  return {
    query,
    start: textBeforeCaret.length - query.length - 1,
    end: textBeforeCaret.length,
  };
}

export function matchingHarnessMentions(
  textBeforeCaret: string,
  agents: readonly RendererAgent[],
): readonly RendererAgent[] {
  const match = harnessMentionMatch(textBeforeCaret);
  if (!match) return [];
  return agents.filter((agent) => agent.startsWith(match.query));
}

export function harnessMentionLabel(
  agent: RendererAgent,
  codexAccountLabel: string | null,
): string {
  const account = agent === "codex" && codexAccountLabel?.trim() ? ` · ${codexAccountLabel}` : "";
  return `${RENDERER_AGENT_LABELS[agent]}${account}`;
}

export function harnessMentionCandidates(
  agents: readonly RendererAgent[],
  accounts: readonly CodexAccountSummary[],
): HarnessMentionCandidate[] {
  return [
    ...accounts
      .filter((account) => !account.active)
      .map((account) => {
        const displayName = account.email ?? account.label;
        return {
          accountId: account.accountId,
          agent: "codex" as const,
          description: "@codex",
          id: `${HARNESS_COMMAND_PREFIX}codex-${account.accountId}`,
          insertion: `@codex (${displayName}) `,
          title: harnessMentionLabel("codex", displayName),
        };
      }),
    ...agents
      .filter((agent) => agent !== "codex")
      .map((agent) => ({
        agent,
        description: `@${agent}`,
        id: `${HARNESS_COMMAND_PREFIX}${agent}`,
        insertion: `@${agent} `,
        title: harnessMentionLabel(agent, null),
      })),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNativeComposerCommand(value: unknown): value is NativeComposerCommand {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.description === "string" &&
    typeof value.requiresEmptyComposer === "boolean" &&
    (typeof value.onSelect === "function" || isRecord(value.submenu))
  );
}

export function isNativeComposerCommandRegistry(value: unknown): value is NativeComposerCommand[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNativeComposerCommand);
}

export function injectNativeHarnessCommands(
  registry: NativeComposerCommand[],
  harnessCommands: readonly NativeComposerCommand[],
): void {
  registry.splice(
    0,
    registry.length,
    ...registry.filter((command) => !command.id.startsWith(HARNESS_COMMAND_PREFIX)),
    ...harnessCommands,
  );
}

export function textWithHarnessMention(
  value: string,
  start: number,
  end: number,
  replacement: string,
): { caret: number; value: string } {
  const boundedStart = Math.max(0, Math.min(start, value.length));
  const boundedEnd = Math.max(boundedStart, Math.min(end, value.length));
  return {
    caret: boundedStart + replacement.length,
    value: value.slice(0, boundedStart) + replacement + value.slice(boundedEnd),
  };
}

export function insertHarnessMention(editor: HTMLElement, replacement: string): boolean {
  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    if (start === null || end === null) return false;
    const inserted = textWithHarnessMention(editor.value, start, end, replacement);
    editor.value = inserted.value;
    editor.setSelectionRange(inserted.caret, inserted.caret);
    editor.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: replacement }),
    );
    return true;
  }
  const selection = editor.ownerDocument.getSelection();
  if (!selection || selection.rangeCount !== 1) return false;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return false;
  if (
    typeof editor.ownerDocument.execCommand === "function" &&
    editor.ownerDocument.execCommand("insertText", false, replacement)
  ) {
    return true;
  }
  range.deleteContents();
  const text = editor.ownerDocument.createTextNode(replacement);
  range.insertNode(text);
  range.setStartAfter(text);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  editor.dispatchEvent(
    new InputEvent("input", { bubbles: true, inputType: "insertText", data: replacement }),
  );
  return true;
}

function reactFiberForEditor(editor: HTMLElement): ReactFiber | null {
  let element: HTMLElement | null = editor;
  while (element) {
    const key = Object.getOwnPropertyNames(element).find((name) =>
      name.startsWith(REACT_FIBER_PREFIX),
    );
    if (key) {
      return (
        ((element as unknown as Record<string, unknown>)[key] as ReactFiber | undefined) ?? null
      );
    }
    element = element.parentElement;
  }
  return null;
}

function reactRootForEditor(editor: HTMLElement): ReactFiber | null {
  let fiber = reactFiberForEditor(editor);
  while (fiber?.return) fiber = fiber.return;
  return fiber;
}

function nativeContextualSuggestions(value: unknown): NativeContextualSuggestions | null {
  if (!isRecord(value) || !isRecord(value.contextualSuggestions)) return null;
  const suggestions = value.contextualSuggestions;
  return Array.isArray(suggestions.leadingItems) &&
    typeof suggestions.onAddContext === "function" &&
    typeof suggestions.onRequestClose === "function" &&
    typeof suggestions.onUpdateSelectedMention === "function"
    ? (suggestions as unknown as NativeContextualSuggestions)
    : null;
}

function ownsNativeContextualSuggestions(value: unknown): boolean {
  return nativeContextualSuggestions(value) !== null;
}

export function closeNativeContextualSuggestions(editorFiber: unknown): number {
  if (!isRecord(editorFiber)) return 0;
  const closers = new Set<() => void>();
  let fiber: ReactFiber | null | undefined = editorFiber as ReactFiber;
  for (let depth = 0; fiber && depth < MAX_HOOK_SCAN; depth += 1) {
    for (const candidate of [fiber, fiber.alternate]) {
      if (!candidate) continue;
      for (const value of [candidate.memoizedProps, candidate.pendingProps]) {
        const suggestions = nativeContextualSuggestions(value);
        if (suggestions) closers.add(suggestions.onRequestClose);
      }
    }
    fiber = fiber.return;
  }
  for (const close of closers) close();
  return closers.size;
}

export function completeHarnessMentionSelection(
  candidate: HarnessMentionCandidate,
  onSelectCodexAccount: (accountId: string) => boolean | undefined | Promise<boolean | undefined>,
  insert: (replacement: string) => void,
  close: () => void,
): void {
  close();
  if (!candidate.accountId) {
    insert(candidate.insertion);
    queueMicrotask(close);
    return;
  }
  let selected: boolean | undefined | Promise<boolean | undefined>;
  try {
    selected = onSelectCodexAccount(candidate.accountId);
  } catch {
    return;
  }
  void Promise.resolve(selected).then(
    (accepted) => {
      if (accepted === false) return;
      insert(candidate.insertion);
      close();
      queueMicrotask(close);
    },
    () => undefined,
  );
}

function commandRegistriesFromFiber(fiber: ReactFiber): NativeComposerCommand[][] {
  const registries: NativeComposerCommand[][] = [];
  const seen = new Set<ReactHook>();
  let hook = fiber.memoizedState;
  for (let index = 0; hook && index < MAX_HOOK_SCAN && !seen.has(hook); index += 1) {
    seen.add(hook);
    for (const value of [hook.memoizedState, hook.baseState]) {
      if (isNativeComposerCommandRegistry(value)) registries.push(value);
    }
    hook = hook.next;
  }
  return registries;
}

function injectIntoFiberTree(root: ReactFiber, commands: readonly NativeComposerCommand[]): number {
  const stack: ReactFiber[] = [root, ...(root.alternate ? [root.alternate] : [])];
  const seen = new Set<ReactFiber>();
  const registries = new Set<NativeComposerCommand[]>();
  while (stack.length > 0 && seen.size < MAX_FIBER_SCAN) {
    const fiber = stack.pop();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    if (
      ownsNativeContextualSuggestions(fiber.memoizedProps) ||
      ownsNativeContextualSuggestions(fiber.pendingProps)
    ) {
      for (const registry of commandRegistriesFromFiber(fiber)) registries.add(registry);
    }
    if (fiber.child) stack.push(fiber.child);
    if (fiber.sibling) stack.push(fiber.sibling);
  }
  for (const registry of registries) injectNativeHarnessCommands(registry, commands);
  return registries.size;
}

export function mountRendererHarnessMentionControl(
  editor: HTMLElement,
  _composerId: string,
  agents: readonly RendererAgent[],
  onSelectCodexAccount: (accountId: string) => boolean | undefined | Promise<boolean | undefined>,
): RendererHarnessMentionControl {
  let availableAgents = [...agents];
  let codexAccounts: readonly CodexAccountSummary[] = [];
  let disposed = false;
  let deferredRefresh: number | null = null;

  const insert = (replacement: string): void => {
    insertHarnessMention(editor, replacement);
    editor.focus();
  };
  const commands = (): NativeComposerCommand[] =>
    harnessMentionCandidates(availableAgents, codexAccounts).map((candidate) => ({
      description: candidate.description,
      enabled: true,
      id: candidate.id,
      onSelect: () => {
        const close = (): void => {
          const fiber = reactFiberForEditor(editor);
          if (fiber) closeNativeContextualSuggestions(fiber);
        };
        completeHarnessMentionSelection(candidate, onSelectCodexAccount, insert, close);
      },
      requiresEmptyComposer: false,
      title: candidate.title,
      triggers: ["@"],
    }));
  const refresh = (): void => {
    if (disposed) return;
    const root = reactRootForEditor(editor);
    const registryCount = root ? injectIntoFiberTree(root, commands()) : 0;
    editor.setAttribute(REGISTRY_COUNT_ATTRIBUTE, String(registryCount));
  };
  const refreshAfterNativeUpdate = (): void => {
    refresh();
    queueMicrotask(refresh);
    if (deferredRefresh !== null) window.clearTimeout(deferredRefresh);
    deferredRefresh = window.setTimeout(() => {
      deferredRefresh = null;
      refresh();
    }, 0);
  };
  const observer = new MutationObserver(refresh);
  observer.observe(editor.closest("[data-codex-composer-root]") ?? editor.parentElement ?? editor, {
    childList: true,
    subtree: true,
  });
  // Refresh before ProseMirror handles the keystroke so the parent Composer
  // builds its native leadingItems from the injected command registry.
  editor.addEventListener("keydown", refreshAfterNativeUpdate, true);
  editor.addEventListener("beforeinput", refreshAfterNativeUpdate, true);
  editor.addEventListener("input", refreshAfterNativeUpdate);
  editor.addEventListener("focus", refreshAfterNativeUpdate);
  refresh();

  return {
    setAgents(nextAgents) {
      availableAgents = [...nextAgents];
      refresh();
    },
    setCodexAccounts(accounts) {
      codexAccounts = [...accounts];
      editor.setAttribute(ACCOUNT_COUNT_ATTRIBUTE, String(codexAccounts.length));
      refresh();
    },
    handleKeyDown() {
      return false;
    },
    refresh,
    close() {},
    dispose() {
      if (disposed) return;
      disposed = true;
      if (deferredRefresh !== null) window.clearTimeout(deferredRefresh);
      observer.disconnect();
      editor.removeEventListener("keydown", refreshAfterNativeUpdate, true);
      editor.removeEventListener("beforeinput", refreshAfterNativeUpdate, true);
      editor.removeEventListener("input", refreshAfterNativeUpdate);
      editor.removeEventListener("focus", refreshAfterNativeUpdate);
      editor.removeAttribute(REGISTRY_COUNT_ATTRIBUTE);
      editor.removeAttribute(ACCOUNT_COUNT_ATTRIBUTE);
      const root = reactRootForEditor(editor);
      if (root) injectIntoFiberTree(root, []);
    },
  };
}

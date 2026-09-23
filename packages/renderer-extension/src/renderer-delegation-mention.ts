/**
 * `#` menu for the Codex Composer.
 *
 * Typing `#` opens a floating list with the delegation targets (Harnesses)
 * first, then the current Harness's native commands and skills (the same
 * catalog and selection path as the Composer ⌘ button). Picking a command removes `#query` and runs
 * or claims it exactly like the button. Picking
 * one replaces `#query` with Codex Desktop's native `agentMention` chip, so
 * deletion, cursor movement, serialization and history rendering stay native.
 * The chip is inserted through Desktop's Composer controller when available;
 * otherwise the Markdown carrier `[@Label](subagent://codexhost.<id>)` is
 * pasted for Desktop to restore. When Desktop keeps it as text (plain-text
 * editor setting), the Host still rewrites the literal carrier the same way.
 */
import {
  DELEGATION_MENTION_PATH_PREFIX,
  HARNESS_COMMAND_MENTION_PATH_PREFIX,
  delegationMentionPath,
  formatDelegationMentionLink,
  harnessCommandMentionPath,
} from "@codexhost/shared-contracts";

import type { HarnessCommandDescriptor } from "@codexhost/shared-contracts";

import type { RendererAgent } from "./agent-selection-state.js";
import { createRendererAgentIcon } from "./renderer-agent-icon.js";
import { rendererHarnessCommandExecutesDirectly } from "./renderer-harness-command-claim.js";
import { createHarnessCommandIcon } from "./renderer-harness-command-control.js";
import { rendererHarnessCommandPresentation } from "./renderer-harness-localization.js";
import {
  deleteNativeRange,
  insertNativeAgentMention,
  insertNativeTextAtSelection,
  type NativeTextRange,
} from "./renderer-native-composer-controller.js";
import type { RendererSettingsLocale } from "./settings/localization.js";

const MENU_ATTRIBUTE = "data-codexhost-delegation-mention-menu";
const STYLE_ATTRIBUTE = "data-codexhost-delegation-mention-style";
const MENU_MAX_HEIGHT = 320;
const SOURCE_TAG = "codexhost";
// Class lists mirror Desktop's composer suggestion menu (measured from the
// native `@` menu), so density, colors and light/dark theming follow Desktop.
const MENU_CLASS =
  "border-default bg-surface-elevated-secondary flex flex-col overflow-hidden " +
  "rounded-[var(--radius-suggestion-menu,var(--radius-2xl))] border text-sm backdrop-blur-sm";
const LIST_CLASS = "vertical-scroll-fade-mask flex w-full flex-1 flex-col overflow-y-auto";
const HEADER_CLASS =
  "text-codex-description sticky top-0 z-10 px-row-x py-1 text-sm bg-surface-elevated-secondary";
const ROW_CLASS =
  "text-default outline-hidden cursor-interaction flex w-full min-h-[var(--app-menu-item-height,0px)] " +
  "shrink-0 items-center overflow-hidden rounded-[var(--suggestion-menu-item-radius,var(--radius-xl))] " +
  "p-[var(--suggestion-menu-item-padding,var(--app-menu-item-padding,var(--padding-row-y)_var(--padding-row-x)))] " +
  "text-start text-sm";
const ROW_CONTENT_CLASS =
  "flex w-full min-w-0 items-center gap-[var(--spacing-menu-item-content,calc(var(--spacing)*1.5))]";
const ROW_HIGHLIGHT_CLASSES = ["bg-primary-ghost-hover", "opacity-100"] as const;
const ROW_IDLE_CLASS = "menu-row-opacity";
const VIEWPORT_MARGIN = 8;
const MENU_GAP = 4;
const MAX_QUERY_LENGTH = 32;
const TRIGGER_PATTERN = /(?:^|\s)#([^\s#]*)$/u;

export interface RendererDelegationTarget {
  agent: RendererAgent;
  label: string;
}

export interface RendererDelegationTrigger {
  /** Text typed after `#`. */
  query: string;
  /** Offset of `#` within the text before the caret. */
  start: number;
}

/**
 * Detect an active `#query` token ending at the caret. `#` must start a word,
 * and a leading digit (`#123`) is treated as an ordinary reference.
 */
export function findDelegationTrigger(textBeforeCaret: string): RendererDelegationTrigger | null {
  const match = TRIGGER_PATTERN.exec(textBeforeCaret);
  if (!match) return null;
  const query = match[1] ?? "";
  if (query.length > MAX_QUERY_LENGTH || /^\d/u.test(query)) return null;
  return { query, start: textBeforeCaret.length - query.length - 1 };
}

export function filterDelegationTargets(
  targets: readonly RendererDelegationTarget[],
  query: string,
): RendererDelegationTarget[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...targets];
  const scored = targets.flatMap((target, index) => {
    const label = target.label.toLowerCase();
    const id = target.agent.toLowerCase();
    const score =
      label.startsWith(needle) || id.startsWith(needle)
        ? 2
        : label.includes(needle) || id.includes(needle)
          ? 1
          : 0;
    return score > 0 ? [{ target, score, index }] : [];
  });
  return scored
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ target }) => target);
}

/** Match Harness commands by invocation (with or without `/`) and label. */
export function filterDelegationCommands(
  commands: readonly HarnessCommandDescriptor[],
  query: string,
): HarnessCommandDescriptor[] {
  const needle = query.trim().toLowerCase().replace(/^\//u, "");
  if (!needle) return [...commands];
  const scored = commands.flatMap((command, index) => {
    const invocation = command.invocation.toLowerCase().replace(/^\//u, "");
    const label = command.label.toLowerCase();
    const display = harnessCommandDisplayName(command.label).toLowerCase();
    const score =
      invocation.startsWith(needle) || display.startsWith(needle)
        ? 2
        : invocation.includes(needle) || label.includes(needle) || display.includes(needle)
          ? 1
          : 0;
    return score > 0 ? [{ command, score, index }] : [];
  });
  return scored
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ command }) => command);
}

/**
 * Readable row title like Desktop's own menus ("Code Review" rather than
 * `/skill:code-review`). Labels that are already readable are kept.
 */
export function harnessCommandDisplayName(label: string): string {
  const slug = label
    .trim()
    .replace(/^\//u, "")
    .replace(/^skill:/u, "");
  if (!slug || /\s/u.test(slug) || /[A-Z]/u.test(slug) || /[^\x00-\x7F]/u.test(slug)) {
    return slug || label;
  }
  // Plugin-namespaced names (`plugin:skill`) show the skill part.
  const name = slug.split(":").filter(Boolean).at(-1) ?? slug;
  return name
    .split(/[-_.]+/u)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Outline cube for skills, drawn in the row's text color. */
function createSkillIcon(ownerDocument: Document): SVGSVGElement {
  const svg = ownerDocument.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = ownerDocument.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M12 3 20 7.5v9L12 21l-8-4.5v-9ZM4 7.5 12 12l8-4.5M12 12v9");
  svg.append(path);
  return svg;
}

function agentsTitle(locale: RendererSettingsLocale): string {
  return locale === "zh-CN" ? "委派给 Agent" : "Delegate to agent";
}

function commandsTitle(locale: RendererSettingsLocale): string {
  return locale === "zh-CN" ? "命令" : "Commands";
}

function skillsTitle(locale: RendererSettingsLocale): string {
  return locale === "zh-CN" ? "技能" : "Skills";
}

function iconUrl(agent: RendererAgent, ownerDocument: Document): string | null {
  const icon = createRendererAgentIcon(agent, 16, ownerDocument);
  if (icon.tagName.toLowerCase() === "img") return (icon as HTMLImageElement).src || null;
  const view = ownerDocument.defaultView;
  if (!view?.XMLSerializer) return null;
  const markup = new view.XMLSerializer()
    .serializeToString(icon)
    .replaceAll("currentColor", "#808080");
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

function cssString(value: string): string {
  return `"${value.replace(/["\\\n]/gu, (character) => `\\${character === "\n" ? "a " : character}`)}"`;
}

/**
 * Restyle our native agent mention chips like Desktop's plugin chips: Harness
 * icon, accent-colored name, no `@`. Desktop hard-codes `@` into the chip label
 * and forces it to the default text color, so the label is hidden and the name
 * is drawn from the chip's own `agent-mention-display-name` attribute, which
 * inherits the Mention accent color. The node itself stays untouched.
 */
function syncChipStyle(
  ownerDocument: Document,
  targets: readonly RendererDelegationTarget[],
  cache: Map<RendererAgent, string | null>,
): void {
  let style = ownerDocument.querySelector<HTMLStyleElement>(`style[${STYLE_ATTRIBUTE}]`);
  if (!style) {
    style = ownerDocument.createElement("style");
    style.setAttribute(STYLE_ATTRIBUTE, "true");
    (ownerDocument.head ?? ownerDocument.documentElement).append(style);
  }
  const chip = [DELEGATION_MENTION_PATH_PREFIX, HARNESS_COMMAND_MENTION_PATH_PREFIX]
    .map((prefix) => `[agent-mention-path^=${cssString(prefix)}][agent-mention-display-name]`)
    .join(",");
  const withPseudo = (pseudo: string): string =>
    chip
      .split(",")
      .map((selector) => `${selector}${pseudo}`)
      .join(",");
  const rules = [
    withPseudo(" > span:last-child") + "{display:none;}",
    withPseudo("::after") + "{content:attr(agent-mention-display-name);}",
    ...targets.flatMap(({ agent }) => {
      if (!cache.has(agent)) cache.set(agent, iconUrl(agent, ownerDocument));
      const url = cache.get(agent);
      if (!url) return [];
      const selector = `[agent-mention-path=${cssString(delegationMentionPath(agent))}]::before`;
      return [
        `${selector}{content:"";display:inline-block;width:16px;height:16px;` +
          `margin-inline-end:3px;vertical-align:-3px;` +
          `background:url(${cssString(url)}) center/contain no-repeat;}`,
      ];
    }),
  ];
  const text = rules.join("\n");
  if (style.textContent !== text) style.textContent = text;
}

interface ActiveTrigger {
  editor: HTMLElement;
  node: Text;
  start: number;
  end: number;
  query: string;
}

export interface RendererDelegationMentionOptions {
  readTargets(): readonly RendererDelegationTarget[];
  /** Whether the editable element belongs to a Composer we manage. */
  isComposerEditor(editor: HTMLElement): boolean;
  readLocale(): RendererSettingsLocale;
  /** Element the menu spans, like Desktop's own suggestion menu (the Composer). */
  anchorForEditor(editor: HTMLElement): Element | null;
  /** Native commands of the Composer's current Harness, if it has any. */
  readCommands(editor: HTMLElement): RendererDelegationCommandSource | null;
  /** Called when the menu opens for an editor, e.g. to refresh live commands. */
  onOpen?(editor: HTMLElement): void;
}

export interface RendererDelegationMentionControl {
  /** Re-render the open menu after its data sources changed. */
  refresh(): void;
  /** Type `#` at the editor caret (spaced from a preceding word) to open the menu. */
  openFor(editor: HTMLElement): void;
  dispose(): void;
}

/** Same catalog and selection path as the Composer command (⌘) button. */
export interface RendererDelegationCommandSource {
  commands: readonly HarnessCommandDescriptor[];
  /**
   * Shown below the commands while the workspace's live commands and skills
   * are not loaded yet (a draft whose native Session has not run).
   */
  pendingNotice?: string | null;
  /** Non-null when the command cannot run now; shown instead of its description. */
  disabledReason(command: HarnessCommandDescriptor): string | null;
  select(command: HarnessCommandDescriptor): void;
}

type MenuEntry =
  | { kind: "command"; command: HarnessCommandDescriptor; source: RendererDelegationCommandSource }
  | { kind: "agent"; target: RendererDelegationTarget };

export function installRendererDelegationMention(
  ownerDocument: Document,
  options: RendererDelegationMentionOptions,
): RendererDelegationMentionControl {
  const view = ownerDocument.defaultView;
  if (!view) {
    return { refresh: () => undefined, openFor: () => undefined, dispose: () => undefined };
  }
  const iconCache = new Map<RendererAgent, string | null>();

  // Codex's own suggestion menu utilities, so light/dark theming and density
  // follow Desktop. The fixed position and z-index stay inline because the
  // menu lives on <body> rather than inside the Composer tree.
  const menu = ownerDocument.createElement("div");
  menu.setAttribute(MENU_ATTRIBUTE, "true");
  menu.className = MENU_CLASS;
  Object.assign(menu.style, {
    display: "none",
    position: "fixed",
    zIndex: "2147483647",
    maxHeight: `min(${MENU_MAX_HEIGHT}px, calc(100vh - ${VIEWPORT_MARGIN * 2}px))`,
    padding: "var(--spacing)",
  } satisfies Partial<CSSStyleDeclaration>);
  const list = ownerDocument.createElement("div");
  list.className = LIST_CLASS;
  list.setAttribute("role", "listbox");
  menu.append(list);
  ownerDocument.body.append(menu);

  // The `flex` utility would override the `hidden` attribute, so visibility
  // is controlled inline.
  const isMenuOpen = (): boolean => menu.style.display !== "none";
  const setMenuOpen = (open: boolean): void => {
    menu.style.display = open ? "flex" : "none";
  };

  let active: ActiveTrigger | null = null;
  /** Selectable entries in display order; disabled commands are not included. */
  let entries: MenuEntry[] = [];
  let activeIndex = 0;
  let composing = false;
  let inserting = false;
  let openedFor: { node: Text; start: number } | null = null;
  let rowsRendered = 0;

  const close = (): void => {
    active = null;
    entries = [];
    setMenuOpen(false);
    list.replaceChildren();
  };

  const highlight = (): void => {
    [...list.querySelectorAll<HTMLElement>("[role=option]")].forEach((item, index) => {
      const selected = index === activeIndex;
      item.setAttribute("aria-selected", String(selected));
      for (const name of ROW_HIGHLIGHT_CLASSES) item.classList.toggle(name, selected);
      item.classList.toggle(ROW_IDLE_CLASS, !selected);
      if (selected) item.scrollIntoView({ block: "nearest" });
    });
  };

  /** Match Desktop: span the Composer and sit just above it. */
  const position = (trigger: ActiveTrigger): void => {
    const anchor = options.anchorForEditor(trigger.editor) ?? trigger.editor;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(rect.width, view.innerWidth - VIEWPORT_MARGIN * 2);
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.left, view.innerWidth - width - VIEWPORT_MARGIN),
    );
    menu.style.width = `${width}px`;
    menu.style.left = `${left}px`;
    const height = menu.getBoundingClientRect().height;
    const above = rect.top >= height + MENU_GAP + VIEWPORT_MARGIN;
    menu.style.top = above
      ? `${rect.top - height - MENU_GAP}px`
      : `${Math.min(view.innerHeight - height - VIEWPORT_MARGIN, rect.bottom + MENU_GAP)}px`;
  };

  /** Every section carries a quiet source tag, like Desktop's "Personal". */
  const sectionHeader = (title: string): HTMLElement => {
    const header = ownerDocument.createElement("div");
    header.className = `${HEADER_CLASS} flex items-center justify-between gap-2`;
    const label = ownerDocument.createElement("span");
    label.className = "min-w-0 truncate";
    label.textContent = title;
    const source = ownerDocument.createElement("span");
    source.className = "shrink-0 text-sm text-codex-description";
    source.setAttribute("data-codexhost-source", "");
    source.textContent = SOURCE_TAG;
    header.append(label, source);
    return header;
  };

  const rowContent = (
    leading: Element | null,
    labelText: string,
    detailText: string,
  ): HTMLElement => {
    const content = ownerDocument.createElement("div");
    content.className = ROW_CONTENT_CLASS;
    if (leading) {
      leading.classList.add("icon-xs", "shrink-0");
      content.append(leading);
    }
    const label = ownerDocument.createElement("span");
    label.className = "min-w-0 shrink truncate";
    label.textContent = labelText;
    content.append(label);
    if (detailText) {
      const detail = ownerDocument.createElement("span");
      detail.className = "flex-1 truncate text-codex-description";
      detail.textContent = detailText;
      content.append(detail);
    }
    return content;
  };

  const optionRow = (entry: MenuEntry, content: HTMLElement): HTMLElement => {
    const index = entries.length;
    entries.push(entry);
    const item = ownerDocument.createElement("div");
    item.setAttribute("role", "option");
    item.className = ROW_CLASS;
    item.append(content);
    item.addEventListener("pointermove", () => {
      if (activeIndex === index) return;
      activeIndex = index;
      highlight();
    });
    // Keep editor focus and selection while choosing with the pointer.
    item.addEventListener("mousedown", (event) => event.preventDefault());
    item.addEventListener("click", () => void choose(entry));
    return item;
  };

  const render = (
    trigger: ActiveTrigger,
    commands: {
      source: RendererDelegationCommandSource;
      matches: HarnessCommandDescriptor[];
    } | null,
    targets: RendererDelegationTarget[],
  ): void => {
    const locale = options.readLocale();
    const rows: HTMLElement[] = [];
    entries = [];
    if (targets.length > 0) {
      rows.push(sectionHeader(agentsTitle(locale)));
      for (const target of targets) {
        rows.push(
          optionRow(
            { kind: "agent", target },
            rowContent(createRendererAgentIcon(target.agent, 16, ownerDocument), target.label, ""),
          ),
        );
      }
    }
    if (commands) {
      // Harnesses that report the distinction get separate Skills; everything
      // else is a command, like Desktop's own `/` vs `$` split.
      const groups: [string, HarnessCommandDescriptor[]][] = [
        [commandsTitle(locale), commands.matches.filter(({ kind }) => kind !== "skill")],
        [skillsTitle(locale), commands.matches.filter(({ kind }) => kind === "skill")],
      ];
      for (const [title, group] of groups) {
        if (group.length === 0) continue;
        rows.push(sectionHeader(title));
        for (const command of group) {
          const reason = commands.source.disabledReason(command);
          const presentation = rendererHarnessCommandPresentation(command, locale);
          const content = rowContent(
            command.kind === "skill"
              ? createSkillIcon(ownerDocument)
              : createHarnessCommandIcon(ownerDocument),
            harnessCommandDisplayName(presentation.label),
            reason ?? presentation.description,
          );
          content.setAttribute("data-command-id", command.id);
          if (reason === null) {
            rows.push(optionRow({ kind: "command", command, source: commands.source }, content));
          } else {
            const disabled = ownerDocument.createElement("div");
            disabled.setAttribute("aria-disabled", "true");
            disabled.className = `${ROW_CLASS} opacity-50`;
            disabled.append(content);
            rows.push(disabled);
          }
        }
      }
    }
    const notice = commands?.source.pendingNotice;
    if (notice && (rows.length > 0 || trigger.query === "")) {
      if (!rows.some((row) => row.querySelector("[data-command-id]"))) {
        rows.push(sectionHeader(commandsTitle(locale)));
      }
      const hint = ownerDocument.createElement("div");
      hint.setAttribute("data-codexhost-command-notice", "");
      hint.className = "px-row-x py-1.5 text-sm text-codex-description";
      hint.textContent = notice;
      rows.push(hint);
    }
    rowsRendered = rows.length;
    list.replaceChildren(...rows);
    activeIndex = Math.min(activeIndex, Math.max(0, entries.length - 1));
    setMenuOpen(true);
    highlight();
    position(trigger);
  };

  const readTrigger = (): ActiveTrigger | null => {
    const selection = ownerDocument.getSelection();
    if (!selection?.isCollapsed || selection.rangeCount === 0) return null;
    const node = selection.anchorNode;
    if (!node || node.nodeType !== node.TEXT_NODE) return null;
    const editor = node.parentElement?.closest<HTMLElement>('[contenteditable="true"]');
    if (!editor || !options.isComposerEditor(editor)) return null;
    const text = node as Text;
    const found = findDelegationTrigger(text.data.slice(0, selection.anchorOffset));
    if (!found) return null;
    return {
      editor,
      node: text,
      start: found.start,
      end: selection.anchorOffset,
      query: found.query,
    };
  };

  const refresh = (): void => {
    if (inserting || composing) return;
    const trigger = readTrigger();
    if (!trigger) {
      openedFor = null;
      close();
      return;
    }
    // Notify once per `#` token so a data refresh cannot re-trigger itself.
    if (openedFor?.node !== trigger.node || openedFor.start !== trigger.start) {
      openedFor = { node: trigger.node, start: trigger.start };
      options.onOpen?.(trigger.editor);
    }
    const allTargets = options.readTargets();
    syncChipStyle(ownerDocument, allTargets, iconCache);
    const targets = filterDelegationTargets(allTargets, trigger.query);
    const source = options.readCommands(trigger.editor);
    const commandMatches = source ? filterDelegationCommands(source.commands, trigger.query) : [];
    const showsNotice = Boolean(source?.pendingNotice) && trigger.query === "";
    if (targets.length === 0 && commandMatches.length === 0 && !showsNotice) {
      close();
      return;
    }
    const sameQuery = active?.query === trigger.query && active.node === trigger.node;
    active = trigger;
    if (!sameQuery) activeIndex = 0;
    render(trigger, source ? { source, matches: commandMatches } : null, targets);
    // Keep a menu of only disabled rows open so their explanation stays visible.
    if (rowsRendered === 0) close();
  };

  const waitForSelectionSync = (): Promise<void> =>
    new Promise((resolve) => view.setTimeout(resolve, 0));

  const selectTriggerText = async (trigger: ActiveTrigger): Promise<boolean> => {
    const selection = ownerDocument.getSelection();
    if (!selection) return false;
    const range = ownerDocument.createRange();
    range.setStart(trigger.node, trigger.start);
    range.setEnd(trigger.node, trigger.end);
    trigger.editor.focus({ preventScroll: true });
    selection.removeAllRanges();
    selection.addRange(range);
    // ProseMirror adopts DOM selection changes asynchronously.
    await waitForSelectionSync();
    return true;
  };

  const insertAgent = async (
    trigger: ActiveTrigger,
    range: NativeTextRange,
    target: RendererDelegationTarget,
  ): Promise<void> => {
    const path = delegationMentionPath(target.agent);
    // Preferred: Desktop's own controller inserts an inline agent mention
    // exactly like its `@` menu, independent of the plain-text editor setting.
    if (
      insertNativeAgentMention(trigger.editor, range, {
        name: target.label,
        displayName: target.label,
        path,
      })
    ) {
      return;
    }
    if (!(await selectTriggerText(trigger))) return;
    const carrier = `${formatDelegationMentionLink({ harnessId: target.agent, label: target.label })} `;
    const pasted = dispatchPlainTextPaste(trigger.editor, carrier);
    if (!pasted) ownerDocument.execCommand("insertText", false, carrier);
  };

  const runCommand = async (
    trigger: ActiveTrigger,
    range: NativeTextRange,
    entry: Extract<MenuEntry, { kind: "command" }>,
  ): Promise<void> => {
    const { command, source } = entry;
    // Commands taking text become a chip in place of `#query`: literal
    // `/command` text would open Desktop's own `/` menu. The Host restores the
    // chip to a leading `/command arguments` on submit.
    if (!rendererHarnessCommandExecutesDirectly(command)) {
      let path: string | null = null;
      try {
        path = harnessCommandMentionPath(command.invocation);
      } catch {
        path = null;
      }
      if (
        path &&
        insertNativeAgentMention(trigger.editor, range, {
          name: command.invocation,
          displayName: command.invocation,
          path,
        })
      ) {
        return;
      }
    }
    // Direct commands (and the no-controller fallback) use the ⌘ button path.
    if (!deleteNativeRange(trigger.editor, range)) {
      if (!(await selectTriggerText(trigger))) return;
      ownerDocument.execCommand("delete");
    }
    source.select(command);
  };

  const choose = async (entry: MenuEntry): Promise<void> => {
    const trigger = active;
    close();
    if (!trigger || !trigger.node.isConnected) return;
    const expected = `#${trigger.query}`;
    if (trigger.node.data.slice(trigger.start, trigger.end) !== expected) return;
    const range = { node: trigger.node, start: trigger.start, end: trigger.end, expected };
    inserting = true;
    try {
      if (entry.kind === "agent") await insertAgent(trigger, range, entry.target);
      else await runCommand(trigger, range, entry);
    } finally {
      inserting = false;
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!isMenuOpen() || !active || event.isComposing) return;
    // With nothing selectable, only Escape belongs to the menu.
    if (entries.length === 0 && event.key !== "Escape") return;
    let handled = true;
    if (event.key === "ArrowDown") activeIndex = (activeIndex + 1) % entries.length;
    else if (event.key === "ArrowUp") {
      activeIndex = (activeIndex - 1 + entries.length) % entries.length;
    } else if (event.key === "Enter" || event.key === "Tab") {
      const entry = entries[activeIndex];
      if (entry) void choose(entry);
    } else if (event.key === "Escape") close();
    else handled = false;
    if (!handled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (isMenuOpen()) highlight();
  };

  const onCompositionStart = (): void => {
    composing = true;
  };
  const onCompositionEnd = (): void => {
    composing = false;
    refresh();
  };
  const onPointerDown = (event: PointerEvent): void => {
    if (isMenuOpen() && !menu.contains(event.target as Node)) close();
  };
  const onViewportChange = (): void => {
    if (active && isMenuOpen()) position(active);
  };

  // Window capture runs before the Composer submit handlers registered on the
  // document, so Enter picks a target instead of sending the prompt.
  view.addEventListener("keydown", onKeyDown, true);
  ownerDocument.addEventListener("input", refresh, true);
  ownerDocument.addEventListener("selectionchange", refresh);
  ownerDocument.addEventListener("compositionstart", onCompositionStart, true);
  ownerDocument.addEventListener("compositionend", onCompositionEnd, true);
  ownerDocument.addEventListener("pointerdown", onPointerDown, true);
  view.addEventListener("resize", onViewportChange);
  view.addEventListener("scroll", onViewportChange, true);

  const dispose = (): void => {
    view.removeEventListener("keydown", onKeyDown, true);
    ownerDocument.removeEventListener("input", refresh, true);
    ownerDocument.removeEventListener("selectionchange", refresh);
    ownerDocument.removeEventListener("compositionstart", onCompositionStart, true);
    ownerDocument.removeEventListener("compositionend", onCompositionEnd, true);
    ownerDocument.removeEventListener("pointerdown", onPointerDown, true);
    view.removeEventListener("resize", onViewportChange);
    view.removeEventListener("scroll", onViewportChange, true);
    menu.remove();
    ownerDocument.querySelector(`style[${STYLE_ATTRIBUTE}]`)?.remove();
  };

  const openFor = (editor: HTMLElement): void => {
    editor.focus({ preventScroll: true });
    const trigger = (previous: string): string => (previous && !/\s/u.test(previous) ? " #" : "#");
    if (insertNativeTextAtSelection(editor, trigger)) return;
    const selection = ownerDocument.getSelection();
    const node = selection?.anchorNode;
    const previous =
      node?.nodeType === node?.TEXT_NODE && selection && selection.anchorOffset > 0
        ? (node as Text).data.charAt(selection.anchorOffset - 1)
        : "";
    ownerDocument.execCommand("insertText", false, trigger(previous));
  };

  return {
    openFor,
    refresh: () => {
      if (openedFor) refresh();
    },
    dispose,
  };
}

/** Returns true when the editor consumed the paste. */
function dispatchPlainTextPaste(editor: HTMLElement, text: string): boolean {
  const view = editor.ownerDocument.defaultView;
  if (!view?.DataTransfer || !view.ClipboardEvent) return false;
  const data = new view.DataTransfer();
  data.setData("text/plain", text);
  const event = new view.ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData: data,
  });
  editor.dispatchEvent(event);
  return event.defaultPrevented;
}

/**
 * `#` menu for the Codex Composer.
 *
 * Typing `#` opens a floating list with the delegation targets (Harnesses)
 * first, then the current Harness's native commands and the Skill Library (the same
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

import type {
  HarnessCommandDescriptor,
  HarnessPluginDescriptor,
  LibrarySkill,
} from "@codexhost/shared-contracts";

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
import { HASH_BOUNDARY, insideMarkdownCode } from "./renderer-reference-trigger.js";
import { createSkillIcon, skillMention } from "./renderer-skill-reference.js";

const MENU_ATTRIBUTE = "data-codexhost-delegation-mention-menu";
const STYLE_ATTRIBUTE = "data-codexhost-delegation-mention-style";
export const DELEGATION_MENTION_MENU_SELECTOR = `[${MENU_ATTRIBUTE}]`;
export const DELEGATION_MENTION_STYLE_SELECTOR = `style[${STYLE_ATTRIBUTE}]`;
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
// `#` or fullwidth `＃` after the start, whitespace or CJK text and punctuation.
const TRIGGER_PATTERN = new RegExp(
  String.raw`(?:^|${HASH_BOUNDARY})[#\uFF03]([^\s#\uFF03]*)$`,
  "u",
);

export interface RendererDelegationTarget {
  agent: RendererAgent;
  label: string;
  plugin?: HarnessPluginDescriptor;
}

export interface RendererDelegationTrigger {
  /** Text typed after `#` or `＃`. */
  query: string;
  /** Offset of `#` or `＃` within the text before the caret. */
  start: number;
}

/**
 * Detect an active `#query` (or fullwidth `＃query`) token ending at the caret.
 * The trigger must follow the start, whitespace, or CJK text and punctuation
 * (see {@link HASH_BOUNDARY}). A leading digit (`#123`) is treated as an
 * ordinary reference, and a trigger inside Markdown code stays text.
 */
export function findDelegationTrigger(textBeforeCaret: string): RendererDelegationTrigger | null {
  const match = TRIGGER_PATTERN.exec(textBeforeCaret);
  if (!match) return null;
  const query = match[1] ?? "";
  if (query.length > MAX_QUERY_LENGTH || /^\d/u.test(query)) return null;
  const start = textBeforeCaret.length - query.length - 1;
  if (insideMarkdownCode(textBeforeCaret.slice(0, start))) return null;
  return { query, start };
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
  const slug = label.trim().replace(/^\//u, "");
  if (!slug || /\s/u.test(slug) || /[A-Z]/u.test(slug) || /[^\x00-\x7F]/u.test(slug)) {
    return slug || label;
  }
  // Namespaced commands show the command part.
  const name = slug.split(":").filter(Boolean).at(-1) ?? slug;
  return name
    .split(/[-_.]+/u)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
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

function iconUrl(
  agent: RendererAgent,
  ownerDocument: Document,
  plugin?: HarnessPluginDescriptor,
): string | null {
  const icon = createRendererAgentIcon(agent, 16, ownerDocument, plugin);
  if (icon.tagName.toLowerCase() === "img") return (icon as HTMLImageElement).src || null;
  const view = ownerDocument.defaultView;
  if (!view?.XMLSerializer || icon.tagName.toLowerCase() !== "svg") return null;
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
    ...targets.flatMap(({ agent, plugin }) => {
      const key = JSON.stringify([plugin?.icon ?? agent, plugin?.iconStyle]);
      if (!cache.has(key)) cache.set(key, iconUrl(agent, ownerDocument, plugin));
      const url = cache.get(key);
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
  /** The typed trigger character, `#` or fullwidth `＃`. */
  char: string;
}

export interface RendererDelegationMentionOptions {
  readTargets(editor: HTMLElement): readonly RendererDelegationTarget[];
  /** Whether the editable element belongs to a Composer we manage. */
  isComposerEditor(editor: HTMLElement): boolean;
  readLocale(): RendererSettingsLocale;
  /** Element the menu spans, like Desktop's own suggestion menu (the Composer). */
  anchorForEditor(editor: HTMLElement): Element | null;
  /** Native commands of the Composer's current Harness, if it has any. */
  readCommands(editor: HTMLElement): RendererDelegationCommandSource | null;
  readSkills?(editor: HTMLElement): RendererDelegationSkillSource | null;
  /** Called when the menu opens for an editor, e.g. to refresh live catalogs. */
  onOpen?(editor: HTMLElement): void;
  onClose?(): void;
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
   * Shown below the commands while the workspace's live commands
   * are not loaded yet (a draft whose native Session has not run).
   */
  pendingNotice?: string | null;
  /** Non-null when the command cannot run now; shown instead of its description. */
  disabledReason(command: HarnessCommandDescriptor): string | null;
  select(command: HarnessCommandDescriptor): void;
}

export interface RendererDelegationSkillSource {
  skills: readonly LibrarySkill[];
  notice?: string;
  warning?: string;
  error?: string;
  retry(): void;
}

export function filterDelegationSkills(
  skills: readonly LibrarySkill[],
  query: string,
): LibrarySkill[] {
  const needle = query.trim().toLowerCase();
  return skills.filter((skill) =>
    `${skill.name}\n${skill.description ?? ""}`.toLowerCase().includes(needle),
  );
}

type MenuEntry =
  | { kind: "command"; command: HarnessCommandDescriptor; source: RendererDelegationCommandSource }
  | { kind: "agent"; target: RendererDelegationTarget }
  | { kind: "librarySkill"; skill: LibrarySkill }
  | { kind: "retrySkills"; retry(): void };

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
  let optionElements: HTMLElement[] = [];
  let activeIndex = 0;
  let highlightedIndex = -1;
  let composing = false;
  let inserting = false;
  let openedFor: { node: Text; start: number } | null = null;
  let rowsRendered = 0;
  let lastRenderKey: string | null = null;
  let lastChipStyleKey: string | null = null;
  let refreshFrame: number | null = null;
  let refreshPending = false;

  const close = (): void => {
    active = null;
    openedFor = null;
    entries = [];
    optionElements = [];
    highlightedIndex = -1;
    lastRenderKey = null;
    setMenuOpen(false);
    list.replaceChildren();
    options.onClose?.();
  };

  const applyOptionSelection = (item: HTMLElement, selected: boolean): void => {
    item.setAttribute("aria-selected", String(selected));
    for (const name of ROW_HIGHLIGHT_CLASSES) item.classList.toggle(name, selected);
    item.classList.toggle(ROW_IDLE_CLASS, !selected);
  };

  const highlight = (scrollToActive: boolean): void => {
    if (highlightedIndex >= 0 && highlightedIndex < optionElements.length) {
      const prev = optionElements[highlightedIndex];
      if (prev && highlightedIndex !== activeIndex) applyOptionSelection(prev, false);
    }
    const next = optionElements[activeIndex];
    if (next) {
      applyOptionSelection(next, true);
      if (scrollToActive) next.scrollIntoView({ block: "nearest" });
    }
    highlightedIndex = next ? activeIndex : -1;
  };

  /** Match Desktop: span the Composer and sit just above it (reads batched before writes). */
  const position = (trigger: ActiveTrigger): void => {
    const anchor = options.anchorForEditor(trigger.editor) ?? trigger.editor;
    const rect = anchor.getBoundingClientRect();
    const viewportWidth = view.innerWidth;
    const viewportHeight = view.innerHeight;
    const width = Math.min(rect.width, viewportWidth - VIEWPORT_MARGIN * 2);
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.left, viewportWidth - width - VIEWPORT_MARGIN),
    );
    const nextWidth = `${width}px`;
    const widthChanged = menu.style.width !== nextWidth;
    const measuredHeight = widthChanged ? null : menu.getBoundingClientRect().height;
    if (widthChanged) menu.style.width = nextWidth;
    menu.style.left = `${left}px`;
    const height = measuredHeight ?? menu.getBoundingClientRect().height;
    const above = rect.top >= height + MENU_GAP + VIEWPORT_MARGIN;
    menu.style.top = above
      ? `${rect.top - height - MENU_GAP}px`
      : `${Math.min(viewportHeight - height - VIEWPORT_MARGIN, rect.bottom + MENU_GAP)}px`;
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
      highlight(false);
    });
    // Keep editor focus and selection while choosing with the pointer.
    item.addEventListener("mousedown", (event) => event.preventDefault());
    item.addEventListener("click", () => void choose(entry));
    optionElements.push(item);
    return item;
  };

  const render = (
    trigger: ActiveTrigger,
    locale: RendererSettingsLocale,
    commands: {
      source: RendererDelegationCommandSource;
      matches: readonly { command: HarnessCommandDescriptor; reason: string | null }[];
    } | null,
    targets: readonly RendererDelegationTarget[],
    skills: {
      source: RendererDelegationSkillSource;
      matches: readonly LibrarySkill[];
    } | null,
    prevActiveIndex: number,
  ): void => {
    const rows: HTMLElement[] = [];
    entries = [];
    optionElements = [];
    if (targets.length > 0) {
      rows.push(sectionHeader(agentsTitle(locale)));
      for (const target of targets) {
        rows.push(
          optionRow(
            { kind: "agent", target },
            rowContent(
              createRendererAgentIcon(target.agent, 16, ownerDocument, target.plugin),
              target.label,
              "",
            ),
          ),
        );
      }
    }
    if (commands) {
      if (commands.matches.length) {
        rows.push(sectionHeader(commandsTitle(locale)));
        for (const { command, reason } of commands.matches) {
          const presentation = rendererHarnessCommandPresentation(command, locale);
          const content = rowContent(
            createHarnessCommandIcon(ownerDocument),
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
    if (skills) {
      rows.push(sectionHeader(skillsTitle(locale)));
      const { source: skillSource, matches } = skills;
      for (const skill of matches) {
        const scope =
          locale === "zh-CN"
            ? skill.scope === "project"
              ? "项目"
              : "全局"
            : skill.scope === "project"
              ? "Project"
              : "Global";
        const detail = `${scope} · ${skill.source} · ${skill.path}${skill.description ? ` — ${skill.description}` : ""}`;
        const content = rowContent(createSkillIcon(ownerDocument), skill.name, detail);
        content.setAttribute("data-skill-path", skill.path);
        content.title = detail;
        rows.push(optionRow({ kind: "librarySkill", skill }, content));
      }
      const hint = (label: string, detail = ""): void => {
        const row = ownerDocument.createElement("div");
        row.className = `${ROW_CLASS} opacity-50`;
        row.setAttribute("aria-disabled", "true");
        row.title = detail;
        row.append(rowContent(null, label, detail));
        rows.push(row);
      };
      if (skillSource.error) {
        rows.push(
          optionRow(
            { kind: "retrySkills", retry: skillSource.retry },
            rowContent(
              null,
              locale === "zh-CN" ? "重试 Skill 库" : "Retry Skill Library",
              skillSource.error,
            ),
          ),
        );
      } else if (skillSource.notice) hint(skillSource.notice);
      else if (!matches.length) hint(locale === "zh-CN" ? "未找到 Skill" : "No Skills found");
      if (skillSource.warning)
        hint(
          locale === "zh-CN" ? "部分 Skill 无法读取" : "Some Skills could not be read",
          skillSource.warning,
        );
    }
    rowsRendered = rows.length;
    activeIndex = Math.min(activeIndex, Math.max(0, entries.length - 1));
    for (let index = 0; index < optionElements.length; index += 1) {
      const item = optionElements[index];
      if (item) applyOptionSelection(item, index === activeIndex);
    }
    highlightedIndex = optionElements[activeIndex] ? activeIndex : -1;

    // Batch layout reads before DOM/style writes to avoid layout thrashing.
    const anchor = options.anchorForEditor(trigger.editor) ?? trigger.editor;
    const rect = anchor.getBoundingClientRect();
    const viewportWidth = view.innerWidth;
    const viewportHeight = view.innerHeight;
    const width = Math.min(rect.width, viewportWidth - VIEWPORT_MARGIN * 2);
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.left, viewportWidth - width - VIEWPORT_MARGIN),
    );

    list.replaceChildren(...rows);
    menu.style.width = `${width}px`;
    menu.style.left = `${left}px`;
    setMenuOpen(true);

    const height = menu.getBoundingClientRect().height;
    const above = rect.top >= height + MENU_GAP + VIEWPORT_MARGIN;
    menu.style.top = above
      ? `${rect.top - height - MENU_GAP}px`
      : `${Math.min(viewportHeight - height - VIEWPORT_MARGIN, rect.bottom + MENU_GAP)}px`;
    if (activeIndex !== prevActiveIndex) {
      optionElements[activeIndex]?.scrollIntoView({ block: "nearest" });
    }
  };

  const readTrigger = (): ActiveTrigger | null => {
    const selection = ownerDocument.getSelection();
    if (!selection?.isCollapsed || selection.rangeCount === 0) return null;
    const node = selection.anchorNode;
    if (!node || node.nodeType !== node.TEXT_NODE) return null;
    const editor = node.parentElement?.closest<HTMLElement>('[contenteditable="true"]');
    if (!editor || !options.isComposerEditor(editor)) return null;
    // Rich-text inline code and code blocks keep `#` as text.
    if (node.parentElement?.closest("code, pre")) return null;
    const text = node as Text;
    const found = findDelegationTrigger(text.data.slice(0, selection.anchorOffset));
    if (!found) return null;
    return {
      editor,
      node: text,
      start: found.start,
      end: selection.anchorOffset,
      query: found.query,
      char: text.data.charAt(found.start),
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
    const allTargets = options.readTargets(trigger.editor);
    const chipStyleKey = allTargets
      .map(({ agent, plugin }) => `${agent}\x1f${plugin?.icon ?? ""}\x1f${plugin?.iconStyle ?? ""}`)
      .join("\x1e");
    if (chipStyleKey !== lastChipStyleKey) {
      lastChipStyleKey = chipStyleKey;
      syncChipStyle(ownerDocument, allTargets, iconCache);
    }
    const targets = filterDelegationTargets(allTargets, trigger.query);
    const source = options.readCommands(trigger.editor);
    const commandMatches = source
      ? filterDelegationCommands(source.commands, trigger.query).map((command) => ({
          command,
          reason: source.disabledReason(command),
        }))
      : [];
    const skills = options.readSkills?.(trigger.editor) ?? null;
    const skillMatches = skills ? filterDelegationSkills(skills.skills, trigger.query) : [];
    const showsNotice = Boolean(source?.pendingNotice) && trigger.query === "";
    if (targets.length === 0 && commandMatches.length === 0 && !showsNotice && !skills) {
      close();
      return;
    }
    const locale = options.readLocale();
    const renderKey = [
      locale,
      targets
        .map(
          ({ agent, label, plugin }) =>
            `${agent}\x1f${label}\x1f${plugin?.icon ?? ""}\x1f${plugin?.iconStyle ?? ""}`,
        )
        .join("\x1e"),
      source
        ? `${source.pendingNotice ?? ""}\x1f${commandMatches
            .map(
              ({ command, reason }) =>
                `${command.id}\x1f${command.label}\x1f${command.description ?? ""}\x1f${reason ?? ""}`,
            )
            .join("\x1e")}`
        : "",
      skills
        ? `${skills.error ?? ""}\x1f${skills.notice ?? ""}\x1f${skills.warning ?? ""}\x1f${skillMatches
            .map(
              (skill) =>
                `${skill.path}\x1f${skill.name}\x1f${skill.scope}\x1f${skill.source}\x1f${skill.description ?? ""}`,
            )
            .join("\x1e")}`
        : "",
    ].join("\x1d");
    const sameQuery =
      active !== null &&
      active.query === trigger.query &&
      active.node === trigger.node &&
      active.start === trigger.start &&
      active.editor === trigger.editor;
    active = trigger;
    if (sameQuery && isMenuOpen() && lastRenderKey === renderKey) return;
    const prevActiveIndex = isMenuOpen() ? activeIndex : 0;
    if (!sameQuery) activeIndex = 0;
    lastRenderKey = renderKey;
    render(
      trigger,
      locale,
      source ? { source, matches: commandMatches } : null,
      targets,
      skills ? { source: skills, matches: skillMatches } : null,
      prevActiveIndex,
    );
    // Keep a menu of only disabled rows open so their explanation stays visible.
    if (rowsRendered === 0) close();
  };

  const cancelScheduledRefresh = (): void => {
    if (refreshFrame !== null) {
      view.cancelAnimationFrame(refreshFrame);
      refreshFrame = null;
    }
    refreshPending = false;
  };

  const flushScheduledRefresh = (): void => {
    cancelScheduledRefresh();
    refresh();
  };

  const scheduleRefresh = (leading: boolean): void => {
    if (leading && refreshFrame === null) {
      refresh();
      refreshFrame = view.requestAnimationFrame(() => {
        refreshFrame = null;
        if (!refreshPending) return;
        refreshPending = false;
        refresh();
      });
      return;
    }
    refreshPending = true;
    if (refreshFrame !== null) return;
    refreshFrame = view.requestAnimationFrame(() => {
      refreshFrame = null;
      if (!refreshPending) return;
      refreshPending = false;
      refresh();
    });
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
    if (entry.kind === "retrySkills") {
      entry.retry();
      return;
    }
    const trigger = active;
    if (entry.kind === "librarySkill" && trigger && !options.readSkills?.(trigger.editor)) return;
    close();
    if (!trigger || !trigger.node.isConnected) return;
    const expected = `${trigger.char}${trigger.query}`;
    if (trigger.node.data.slice(trigger.start, trigger.end) !== expected) return;
    const range = { node: trigger.node, start: trigger.start, end: trigger.end, expected };
    inserting = true;
    try {
      if (entry.kind === "agent") await insertAgent(trigger, range, entry.target);
      else if (entry.kind === "librarySkill") {
        const mention = skillMention(entry.skill);
        if (!insertNativeAgentMention(trigger.editor, range, mention)) {
          if (!(await selectTriggerText(trigger))) return;
          const carrier = `[@${mention.name}](${mention.path}) `;
          if (!dispatchPlainTextPaste(trigger.editor, carrier))
            ownerDocument.execCommand("insertText", false, carrier);
        }
      } else await runCommand(trigger, range, entry);
    } finally {
      inserting = false;
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    if (
      refreshPending &&
      (event.key === "ArrowDown" ||
        event.key === "ArrowUp" ||
        event.key === "Enter" ||
        event.key === "Tab" ||
        event.key === "Escape")
    ) {
      flushScheduledRefresh();
    }
    if (!isMenuOpen() || !active) return;
    // With nothing selectable, only Escape belongs to the menu.
    if (entries.length === 0 && event.key !== "Escape") return;
    const prevActiveIndex = activeIndex;
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
    if (isMenuOpen()) highlight(activeIndex !== prevActiveIndex);
  };

  const onInput = (): void => {
    scheduleRefresh(true);
  };
  const onSelectionChange = (): void => {
    scheduleRefresh(false);
  };
  const onCompositionStart = (): void => {
    composing = true;
  };
  const onCompositionEnd = (): void => {
    composing = false;
    flushScheduledRefresh();
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
  ownerDocument.addEventListener("input", onInput, true);
  ownerDocument.addEventListener("selectionchange", onSelectionChange);
  ownerDocument.addEventListener("compositionstart", onCompositionStart, true);
  ownerDocument.addEventListener("compositionend", onCompositionEnd, true);
  ownerDocument.addEventListener("pointerdown", onPointerDown, true);
  view.addEventListener("resize", onViewportChange);
  view.addEventListener("scroll", onViewportChange, true);

  const dispose = (): void => {
    cancelScheduledRefresh();
    view.removeEventListener("keydown", onKeyDown, true);
    ownerDocument.removeEventListener("input", onInput, true);
    ownerDocument.removeEventListener("selectionchange", onSelectionChange);
    ownerDocument.removeEventListener("compositionstart", onCompositionStart, true);
    ownerDocument.removeEventListener("compositionend", onCompositionEnd, true);
    ownerDocument.removeEventListener("pointerdown", onPointerDown, true);
    view.removeEventListener("resize", onViewportChange);
    view.removeEventListener("scroll", onViewportChange, true);
    options.onClose?.();
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
      if (openedFor) flushScheduledRefresh();
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

import { vi } from "vitest";

/**
 * The DOM double for the Composer speed control's unit tests.
 *
 * It models only what `renderer-codex-service-tier-bolt.ts` actually uses:
 * attribute maps and a child list, the small selector subset the module asks
 * about (comma lists, descendant combinators, `[attr]`, `[attr="v"]`,
 * `[attr*="v"]`, `:popover-open`), the popover API, listeners on nodes and the
 * document, measurement for the flyout positioning, and a MutationObserver the
 * test can fire by hand. Geometry is intentionally simple: an element's
 * viewport rect is its configured base rect plus its own `style.left/top`
 * offsets, which is exactly what `positionFlyout` measures and writes.
 *
 * Browser semantics that guard the module's behavior are modelled the same way
 * the browser defines them, never more loosely:
 * - `isConnected` is derived from the tree: only a subtree under the document's
 *   own root (`FakeDocument.documentElement`) is connected, so a node in a
 *   detached fragment reads `false` exactly like `Node.isConnected`.
 * - `direction` is an inherited property: `getComputedStyle(el).direction`
 *   resolves the nearest ancestor that sets it, defaulting to `ltr`.
 * - Every write primitive (attribute set/remove, append, after, replaceWith,
 *   remove, textContent assign) records a mutation, so a test can assert the
 *   "no writes" guard the way a real MutationObserver would observe it.
 */

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface AttrCondition {
  readonly name: string;
  readonly op?: "=" | "*=";
  readonly value?: string;
}

interface Compound {
  readonly tag: string | null;
  readonly attrs: readonly AttrCondition[];
  readonly popoverOpen: boolean;
}

type Chain = readonly Compound[];

function parseCompound(text: string): Compound {
  const trimmed = text.trim();
  const tagMatch = /^([a-zA-Z][\w-]*)/u.exec(trimmed);
  const rest = tagMatch ? trimmed.slice(tagMatch[1]?.length ?? 0) : trimmed;
  const attrs: AttrCondition[] = [];
  const attrPattern = /\[([^\]*=]+)(?:([*]?=)"([^"]*)")?\]/gu;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(rest)) !== null) {
    attrs.push({
      name: match[1] ?? "",
      ...(match[2] === undefined ? {} : { op: match[2] as "=" | "*=", value: match[3] ?? "" }),
    });
  }
  return {
    tag: tagMatch?.[1]?.toLowerCase() ?? null,
    attrs,
    popoverOpen: rest.includes(":popover-open"),
  };
}

function parseSelector(selector: string): Chain[] {
  return selector
    .split(",")
    .map((group) => group.trim().split(/\s+/u).map(parseCompound))
    .filter((chain) => chain.length > 0);
}

function matchesCompound(node: FakeNode, compound: Compound): boolean {
  if (compound.tag !== null && node.nodeName.toLowerCase() !== compound.tag) return false;
  if (compound.popoverOpen && !node.popoverOpen) return false;
  for (const condition of compound.attrs) {
    const value = node.getAttribute(condition.name);
    if (condition.op === "=" && value !== condition.value) return false;
    if (condition.op === "*=" && !(value ?? "").includes(condition.value ?? "")) return false;
    if (condition.op === undefined && value === null) return false;
  }
  return true;
}

function matchesChain(node: FakeNode, chain: Chain): boolean {
  const last = chain.at(-1);
  if (!last || !matchesCompound(node, last)) return false;
  if (chain.length === 1) return true;
  const rest = chain.slice(0, -1);
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (matchesChain(parent, rest)) return true;
  }
  return false;
}

export class FakeStyle {
  private leftValue = "";
  private topValue = "";
  /**
   * Every `left`/`top` assignment. The module promises a comparison guard, so a
   * reposition with unchanged geometry must leave this count untouched.
   */
  writes = 0;
  get left(): string {
    return this.leftValue;
  }
  set left(value: string) {
    this.writes += 1;
    this.leftValue = value;
  }
  get top(): string {
    return this.topValue;
  }
  set top(value: string) {
    this.writes += 1;
    this.topValue = value;
  }
}

export class FakeNode {
  readonly attributes = new Map<string, string>();
  readonly children: FakeNode[] = [];
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  readonly style = new FakeStyle();
  readonly ownerDocument: FakeDocument;
  parentElement: FakeNode | null = null;
  popoverOpen = false;
  nodeName = "";
  type = "";
  /** Base viewport rect; style.left/top shift it when the module positions. */
  rect: Rect = { left: 0, top: 0, width: 233, height: 120 };
  /** Rendered viewport pixels per local CSS pixel (an ancestor CSS `zoom`). */
  zoomScale = 1;
  /** The element's own `direction`; null means it inherits (like the browser). */
  direction: string | null = null;
  showPopover?: () => void;
  hidePopover?: () => void;
  /** Attribute writes and removals, exactly what a MutationObserver sees. */
  attributeWrites = 0;
  /** Child-list mutations (append / after / replaceWith / remove), same idea. */
  childListWrites = 0;
  private textContentValue: string | null = null;
  private readonly showPopoverSpy = vi.fn(() => {
    this.popoverOpen = true;
  });
  private readonly hidePopoverSpy = vi.fn(() => {
    this.popoverOpen = false;
  });

  constructor(ownerDocument: FakeDocument) {
    this.ownerDocument = ownerDocument;
    if (ownerDocument.popoverSupport) {
      this.showPopover = () => this.showPopoverSpy();
      this.hidePopover = () => this.hidePopoverSpy();
    }
  }

  /** Browser semantics: connected means inside the document's own tree. */
  get isConnected(): boolean {
    const from = (node: FakeNode | null): boolean => {
      if (!node) return false;
      if (node === this.ownerDocument.documentElement) return true;
      return from(node.parentElement);
    };
    return from(this);
  }
  get textContent(): string | null {
    return this.textContentValue;
  }
  set textContent(value: string | null) {
    this.textContentValue = value;
    this.childListWrites += 1;
  }
  /** The element's rendered box width, unzoomed; `offsetWidth` for the scale probe. */
  offsetWidth = 0;
  showPopoverCalls(): number {
    return this.showPopoverSpy.mock.calls.length;
  }
  hidePopoverCalls(): number {
    return this.hidePopoverSpy.mock.calls.length;
  }
  get lastElementChild(): FakeNode | null {
    return this.children.at(-1) ?? null;
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attributeWrites += 1;
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributeWrites += 1;
    this.attributes.delete(name);
  }
  matches(selector: string): boolean {
    return parseSelector(selector).some((chain) => matchesChain(this, chain));
  }
  closest(selector: string): FakeNode | null {
    const chains = parseSelector(selector);
    const from = (node: FakeNode | null): FakeNode | null => {
      if (!node) return null;
      if (chains.some((chain) => matchesChain(node, chain))) return node;
      return from(node.parentElement);
    };
    return from(this);
  }
  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector: string): FakeNode[] {
    const found: FakeNode[] = [];
    const walk = (node: FakeNode): void => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  contains(other: Node | null): boolean {
    if (other === null || other === undefined) return false;
    for (let node = other as unknown as FakeNode | null; node; node = node.parentElement) {
      if (node === this) return true;
    }
    return false;
  }
  append(...nodes: FakeNode[]): void {
    for (const node of nodes) {
      node.remove();
      node.parentElement = this;
      this.children.push(node);
    }
    this.childListWrites += nodes.length;
  }
  after(reference: FakeNode): void {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index < 0) return;
    reference.remove();
    reference.parentElement = parent;
    parent.children.splice(index + 1, 0, reference);
    parent.childListWrites += 1;
  }
  replaceWith(replacement: FakeNode): void {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index < 0) return;
    replacement.remove();
    replacement.parentElement = parent;
    parent.children.splice(index, 1, replacement);
    this.parentElement = null;
    parent.childListWrites += 1;
  }
  remove(): void {
    if (this.parentElement) {
      const index = this.parentElement.children.indexOf(this);
      if (index >= 0) this.parentElement.children.splice(index, 1);
      this.parentElement.childListWrites += 1;
    }
    this.parentElement = null;
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((item) => item !== listener),
    );
  }
  dispatch(type: string, event: unknown): void {
    const cancelled = (): boolean => {
      const spy = (event as { stopPropagation?: { mock?: { calls: unknown[] } } }).stopPropagation;
      return (spy?.mock?.calls.length ?? 0) > 0;
    };
    const walk = (node: FakeNode): void => {
      for (const listener of node.listeners.get(type) ?? []) listener(event);
      if (cancelled()) return;
      if (node.parentElement) walk(node.parentElement);
    };
    walk(this);
  }
  focus(): void {
    this.ownerDocument.activeElement = this;
  }
  getBoundingClientRect(): Rect & { right: number; bottom: number } {
    // `zoomScale` models an ancestor CSS `zoom`: everything measured in viewport
    // pixels scales, while `style.left/top` and `offsetWidth` stay local CSS px.
    const left = this.rect.left + (Number.parseFloat(this.style.left) || 0) * this.zoomScale;
    const top = this.rect.top + (Number.parseFloat(this.style.top) || 0) * this.zoomScale;
    const width = this.rect.width * this.zoomScale;
    const height = this.rect.height * this.zoomScale;
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
    };
  }
}

export class FakeMutationObserver {
  private readonly callback: () => void;
  readonly targets: FakeNode[] = [];
  observedOptions?: MutationObserverInit;
  disconnected = false;

  constructor(ownerDocument: FakeDocument, callback: () => void) {
    this.callback = callback;
    ownerDocument.view.mutationObservers.push(this);
  }

  observe(target: FakeNode, options?: MutationObserverInit): void {
    this.targets.push(target);
    if (options === undefined) delete this.observedOptions;
    else this.observedOptions = options;
  }
  disconnect(): void {
    this.disconnected = true;
  }
  /** Simulate one matching mutation for this observer. */
  fire(): void {
    if (!this.disconnected) this.callback();
  }
}

export class FakeView {
  innerWidth = 1280;
  innerHeight = 800;
  readonly mutationObservers: FakeMutationObserver[] = [];
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  constructor(private readonly ownerDocument: FakeDocument) {}

  get MutationObserver(): typeof FakeMutationObserver {
    return mutationObserverClassFor(this.ownerDocument);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((item) => item !== listener),
    );
  }
  dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  /** Resolves the inherited `direction` like `getComputedStyle` does. */
  getComputedStyle(element: FakeNode): { direction: string } {
    for (let node: FakeNode | null = element; node; node = node.parentElement) {
      if (node.direction !== null) return { direction: node.direction };
    }
    return { direction: "ltr" };
  }
}

/** One MutationObserver subclass bound to its document, as the page sees it. */
function mutationObserverClassFor(ownerDocument: FakeDocument): typeof FakeMutationObserver {
  return class extends FakeMutationObserver {
    constructor(callback: () => void) {
      super(ownerDocument, callback);
    }
  } as unknown as typeof FakeMutationObserver;
}

export class FakeDocument {
  readonly elementsById = new Map<string, FakeNode>();
  readonly view = new FakeView(this);
  /** Mirrors real environment support for the top layer (popover). */
  popoverSupport = true;
  activeElement: unknown = null;
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  private rootNode: FakeNode | null = null;

  /** The tree root. Only subtrees under it read `isConnected`, like the browser. */
  get documentElement(): FakeNode {
    this.rootNode ??= (() => {
      const root = new FakeNode(this);
      root.nodeName = "html";
      return root;
    })();
    return this.rootNode;
  }
  get defaultView(): FakeView {
    return this.view;
  }
  get MutationObserver(): typeof FakeMutationObserver {
    return mutationObserverClassFor(this);
  }

  createElement(tag: string): FakeNode {
    const node = new FakeNode(this);
    node.nodeName = tag;
    if (tag === "button") node.type = "button";
    return node;
  }
  createElementNS(_namespace: string, tag: string): FakeNode {
    const node = new FakeNode(this);
    node.nodeName = tag;
    return node;
  }
  getElementById(id: string): FakeNode | null {
    return this.elementsById.get(id) ?? null;
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((item) => item !== listener),
    );
  }
  /** Document-level capture listeners the module installed while open. */
  dispatchDocument(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  documentListenerCount(type: string): number {
    return (this.listeners.get(type) ?? []).length;
  }
}

export function asElement(node: FakeNode): HTMLElement {
  return node as unknown as HTMLElement;
}

export function clickEvent() {
  return { preventDefault: vi.fn(), stopPropagation: vi.fn(), button: 0 };
}

export function keyEvent(key: string) {
  return { ...clickEvent(), key, code: key };
}

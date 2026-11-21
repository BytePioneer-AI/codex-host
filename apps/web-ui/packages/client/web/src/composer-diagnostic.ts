// 临时诊断，定位后删除。
// 导出：copy(JSON.stringify(window.__composerDiag))

const CAPACITY = 600;
const TAIL_MS = 300;
const EDITOR_SELECTOR = "[data-composer-input]";
const INPUT_SCROLL_SELECTOR = "[data-input-scroll]";
const CHAT_SCROLL_SELECTOR = "[data-conversation-scroll]";

function locate(editor: Element) {
  const card = editor.closest("[data-composer-card]");
  const dock = card?.parentElement?.querySelector(":scope > [data-composer-dock]") ?? null;
  const chat = editor.closest(CHAT_SCROLL_SELECTOR);
  return {
    editor,
    card,
    dock,
    usage: dock?.querySelector('[data-composer-stat="codexhost-usage"]') ?? null,
    quota: dock?.querySelector('[data-composer-stat="codexhost-quota"]') ?? null,
    // ContextMeter has no data marker; its dialog trigger sits in an unmarked dock child.
    contextMeter:
      dock?.querySelector(
        ':scope > span:not([data-composer-stat]) > button[aria-haspopup="dialog"]',
      )?.parentElement ?? null,
    root: editor.ownerDocument.getElementById("root"),
    composerSeat: editor.closest("[data-composer-seat]"),
    inputScroll: editor.closest(INPUT_SCROLL_SELECTOR),
    chat,
    chatFlow: chat?.querySelector("[data-chat-flow]") ?? null,
  };
}

function rect(element: Element | null) {
  if (element === null) return null;
  const { top, bottom, height } = element.getBoundingClientRect();
  return { top, bottom, height };
}

function scrollMetrics(element: Element | null) {
  if (element === null) return null;
  const { scrollTop, scrollHeight, clientHeight } = element;
  return { scrollTop, scrollHeight, clientHeight };
}

function snapshot(browser: Window, elements: ReturnType<typeof locate>) {
  const { innerHeight, scrollY, visualViewport } = browser;
  const card = rect(elements.card);
  const dock = rect(elements.dock);
  const usage = rect(elements.usage);
  const quota = rect(elements.quota);
  // HostUsageDock renders two optional sibling pills, not a single box.
  const hostUsageDock = (() => {
    if (usage === null || quota === null) return usage ?? quota;
    const top = Math.min(usage.top, quota.top);
    const bottom = Math.max(usage.bottom, quota.bottom);
    return { top, bottom, height: bottom - top };
  })();
  return {
    scrollY,
    innerHeight,
    documentScrollHeight: browser.document.documentElement.scrollHeight,
    visualViewport: visualViewport
      ? { height: visualViewport.height, offsetTop: visualViewport.offsetTop }
      : null,
    card,
    dock,
    hostUsageDock,
    contextMeter: rect(elements.contextMeter),
    root: rect(elements.root),
    inputScroll: scrollMetrics(elements.inputScroll),
    chatScroll: scrollMetrics(elements.chat),
    followingTail:
      elements.chatFlow === null
        ? null
        : elements.chatFlow.closest("[data-chat-following-tail]") !== null,
    gapBelowCard: card === null ? null : innerHeight - card.bottom,
    gapBelowDock: dock === null ? null : innerHeight - dock.bottom,
  };
}

type RecordEntry = ReturnType<typeof snapshot> & {
  event: string;
  timestamp: number;
  elapsedMs: number;
  baselineGapBelowCard: number | null;
  resized?: string[];
};

export function installComposerDiagnostic(document: Document): void {
  const browser = document.defaultView;
  if (browser === null) return;
  try {
    if (browser.localStorage.getItem("codexhost.composerDiag") !== "1") return;
  } catch {
    return; // Storage can be unavailable on restricted origins.
  }
  if (Object.hasOwn(browser, "__composerDiag")) return;

  const ring: RecordEntry[] = [];
  let next = 0;
  const readRecords = () => ring.slice(next).concat(ring.slice(0, next));
  Object.defineProperty(browser, "__composerDiag", { configurable: true, get: readRecords });

  let active: {
    editor: Element;
    startedAt: number;
    baselineGap: number | null;
    warned: boolean;
  } | null = null;
  let tailTimer: number | undefined;
  const observed = new Map<Element, string>();
  const observer =
    typeof browser.ResizeObserver === "function"
      ? new browser.ResizeObserver((entries) => {
          const resized = entries.flatMap(({ target }) => observed.get(target) ?? []);
          if (resized.length > 0) record("ResizeObserver", resized);
        })
      : null;

  const finish = (): void => {
    browser.clearTimeout(tailTimer);
    tailTimer = undefined;
    active = null;
    observer?.disconnect();
    observed.clear();
  };

  const record = (event: string, resized?: string[]): void => {
    const composition = active;
    if (composition === null) return;
    if (!composition.editor.isConnected) {
      finish();
      return;
    }
    const timestamp = Date.now();
    const elapsedMs = browser.performance.now() - composition.startedAt;
    const elements = locate(composition.editor);
    const geometry = snapshot(browser, elements);
    if (event === "compositionstart") composition.baselineGap = geometry.gapBelowCard;
    const entry: RecordEntry = {
      event,
      timestamp,
      elapsedMs,
      baselineGapBelowCard: composition.baselineGap,
      ...geometry,
      ...(resized === undefined ? {} : { resized }),
    };
    ring[next] = entry;
    next = (next + 1) % CAPACITY;

    if (
      !composition.warned &&
      composition.baselineGap !== null &&
      entry.gapBelowCard !== null &&
      entry.gapBelowCard - composition.baselineGap >= 24
    ) {
      composition.warned = true;
      console.warn("[composerDiag] gap", entry, readRecords().slice(-20));
    }

    if (observer !== null) {
      const current = new Set(Object.values(elements));
      for (const element of observed.keys()) {
        if (current.has(element)) continue;
        observer.unobserve(element);
        observed.delete(element);
      }
      for (const [name, element] of Object.entries(elements)) {
        if (element === null || observed.has(element)) continue;
        observed.set(element, name);
        observer.observe(element, { box: "border-box" });
      }
    }
  };

  const onComposition = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof browser.Element)) return;
    const editor = target.closest(EDITOR_SELECTOR);
    if (editor === null) return;
    if (event.type === "compositionstart") {
      finish();
      active = { editor, startedAt: browser.performance.now(), baselineGap: null, warned: false };
    } else if (active?.editor !== editor) {
      return;
    }
    record(event.type);
    if (event.type === "compositionend") {
      browser.clearTimeout(tailTimer);
      tailTimer = browser.setTimeout(() => {
        record("compositiontail");
        finish();
      }, TAIL_MS);
    }
  };

  // Capture the start before Lexical's handlers can change the layout.
  for (const event of ["compositionstart", "compositionupdate", "compositionend"]) {
    document.addEventListener(event, onComposition, { capture: true, passive: true });
  }
  document.addEventListener(
    "scroll",
    (event) => {
      if (active === null) return;
      const { editor } = active;
      if (event.target === editor) record("editor.scroll");
      else if (event.target === editor.closest(INPUT_SCROLL_SELECTOR)) record("inputScroll.scroll");
      else if (event.target === editor.closest(CHAT_SCROLL_SELECTOR)) record("chatScroll.scroll");
    },
    { capture: true, passive: true },
  );
  browser.addEventListener("scroll", () => record("window.scroll"), { passive: true });
  browser.visualViewport?.addEventListener("resize", () => record("visualViewport.resize"));
  browser.visualViewport?.addEventListener("scroll", () => record("visualViewport.scroll"));
}

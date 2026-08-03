import {
  hostThreadIdSchema,
  hostTurnIdSchema,
  type HostThreadId,
  type HostTurnId,
} from "@codexhost/shared-contracts";

import type { RendererModelClient } from "./renderer-model-client.js";
import {
  SIDEBAR_THREAD_ROW_SELECTOR,
  threadIdFromSidebarRowElement,
} from "./renderer-sidebar-agent-icons.js";

const RESPONSE_CONVERSATION_ATTRIBUTE = "data-response-annotation-conversation";
const TURN_KEY_ATTRIBUTE = "data-content-search-turn-key";
const OPEN_THREAD_TIMEOUT_MS = 5_000;

export interface RendererForkTarget {
  control: object;
  isProjectlessConversation: boolean;
  threadId: HostThreadId;
  turnId: HostTurnId;
}

export interface RendererForkDom {
  listen(onFork: (target: RendererForkTarget) => boolean): () => void;
  openThread(threadId: HostThreadId): Promise<void>;
  replay(target: RendererForkTarget): void;
}

export interface RendererForkControl {
  dispose(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstFiber(element: Element): Record<string, unknown> | null {
  const names = Object.getOwnPropertyNames(element).filter((name) =>
    name.startsWith("__reactFiber$"),
  );
  const name = names[0];
  if (names.length !== 1 || !name) return null;
  const value = Object.getOwnPropertyDescriptor(element, name)?.value;
  return isRecord(value) ? value : null;
}

export function rendererForkTargetFromButton(button: HTMLButtonElement): RendererForkTarget | null {
  const annotation = button.closest<HTMLElement>(`[${RESPONSE_CONVERSATION_ATTRIBUTE}]`);
  const turnElement = button.closest<HTMLElement>(`[${TURN_KEY_ATTRIBUTE}]`);
  const threadId = hostThreadIdSchema.safeParse(
    annotation?.getAttribute(RESPONSE_CONVERSATION_ATTRIBUTE),
  );
  const turnId = hostTurnIdSchema.safeParse(turnElement?.getAttribute(TURN_KEY_ATTRIBUTE));
  if (!threadId.success || !turnId.success) return null;

  const conversationIds = new Set<string>();
  const turnIds = new Set<string>();
  const hostIds = new Set<string>();
  const projectlessStates = new Set<boolean>();
  let hasForkCallback = false;
  let fiber = firstFiber(button);
  const buttonProps = fiber?.memoizedProps;
  if (!isRecord(buttonProps) || !Object.hasOwn(buttonProps, "aria-busy")) return null;
  for (let depth = 0; fiber && depth < 24; depth += 1) {
    const props = fiber.memoizedProps;
    if (isRecord(props)) {
      if (typeof props.conversationId === "string") conversationIds.add(props.conversationId);
      if (typeof props.turnId === "string") turnIds.add(props.turnId);
      if (typeof props.hostId === "string") hostIds.add(props.hostId);
      if (typeof props.isProjectlessConversation === "boolean") {
        projectlessStates.add(props.isProjectlessConversation);
      }
      if (typeof props.onFork === "function") hasForkCallback = true;
    }
    fiber = isRecord(fiber.return) ? fiber.return : null;
  }
  if (
    !hasForkCallback ||
    conversationIds.size !== 1 ||
    !conversationIds.has(threadId.data) ||
    turnIds.size !== 1 ||
    !turnIds.has(turnId.data) ||
    hostIds.size !== 1 ||
    !hostIds.has("local") ||
    projectlessStates.size !== 1
  ) {
    return null;
  }
  return {
    control: button,
    isProjectlessConversation: projectlessStates.has(true),
    threadId: threadId.data,
    turnId: turnId.data,
  };
}

class BrowserRendererForkDom implements RendererForkDom {
  readonly #replayed = new WeakSet<HTMLButtonElement>();

  listen(onFork: (target: RendererForkTarget) => boolean): () => void {
    const listener = (event: MouseEvent): void => {
      const origin =
        event.target instanceof Element
          ? event.target
          : event.target instanceof Node
            ? event.target.parentElement
            : null;
      const button = origin?.closest<HTMLButtonElement>("button");
      if (!button) return;
      if (this.#replayed.delete(button)) return;
      const target = rendererForkTargetFromButton(button);
      if (!target || !onFork(target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener("click", listener, true);
    return () => document.removeEventListener("click", listener, true);
  }

  replay(target: RendererForkTarget): void {
    if (!(target.control instanceof HTMLButtonElement) || !target.control.isConnected) return;
    this.#replayed.add(target.control);
    target.control.click();
  }

  openThread(threadId: HostThreadId): Promise<void> {
    const find = (): HTMLElement | null => {
      for (const row of document.querySelectorAll<HTMLElement>(SIDEBAR_THREAD_ROW_SELECTOR)) {
        if (threadIdFromSidebarRowElement(row) === threadId) return row;
      }
      return null;
    };
    const current = find();
    if (current) {
      current.click();
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const observer = new MutationObserver(() => {
        const row = find();
        if (!row) return;
        cleanup();
        row.click();
        resolve();
      });
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error("Forked Thread did not appear in the sidebar"));
      }, OPEN_THREAD_TIMEOUT_MS);
      const cleanup = (): void => {
        window.clearTimeout(timeout);
        observer.disconnect();
      };
      observer.observe(document.documentElement, { childList: true, subtree: true });
    });
  }
}

export function installRendererForkControl(options: {
  getClient(): RendererModelClient | null;
  dom?: RendererForkDom;
  reportError?(error: unknown): void;
}): RendererForkControl {
  const dom = options.dom ?? new BrowserRendererForkDom();
  const pending = new Set<string>();
  let disposed = false;
  const stop = dom.listen((target) => {
    if (disposed) return false;
    const client = options.getClient();
    if (!client) return false;
    const key = `${target.threadId}\u0000${target.turnId}`;
    if (pending.has(key)) return true;
    pending.add(key);
    void client
      .inspectThread({ threadId: target.threadId })
      .then(async (inspection) => {
        if (disposed) return;
        if (inspection.owner === "codex" || !target.isProjectlessConversation) {
          dom.replay(target);
          return;
        }
        const result = await client.forkThread({
          threadId: target.threadId,
          lastTurnId: target.turnId,
        });
        if (!disposed) await dom.openThread(result.threadId);
      })
      .catch((error: unknown) => options.reportError?.(error))
      .finally(() => pending.delete(key));
    return true;
  });

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      pending.clear();
    },
  };
}

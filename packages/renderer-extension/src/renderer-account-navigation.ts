import type { HostThreadId } from "@codexhost/shared-contracts";
import { CODEX_COMPOSER_SELECTOR } from "./renderer-composer-dom.js";
import { openRendererThread } from "./renderer-fork-control.js";

export interface AccountThreadView {
  composer: Element;
  threadId: HostThreadId;
}

/** A native identity change replaces Desktop's memory router. The selected local
 * Thread belongs to this window, not that identity. Carry only its ID across the
 * remount; never retain an old client, replay work, or persist Account routing. */
export function createRendererAccountNavigation(currentThread: () => AccountThreadView | null) {
  let cancel = () => {};
  return {
    async switchAccount<T>(operation: () => Promise<T>): Promise<T> {
      cancel();
      const view = currentThread();
      if (!view) return operation();
      const controller = new AbortController();
      let deadline = 0;
      let timer: number | undefined;
      let committed = false;
      let opening = false;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        observer.disconnect();
        if (timer !== undefined) window.clearTimeout(timer);
        document.removeEventListener("pointerdown", onInput, true);
        document.removeEventListener("keydown", onInput, true);
        controller.abort();
      };
      const onInput = (event: Event) => {
        // Settings interaction belongs to this operation. Navigation or typing
        // elsewhere is newer user intent and must not be overridden.
        if (
          !event
            .composedPath()
            .some(
              (node) =>
                node instanceof Element && node.hasAttribute("data-codexhost-settings-shell"),
            )
        )
          finish();
      };
      const restore = () => {
        if (done || !committed || opening || view.composer.isConnected) return;
        if (Date.now() >= deadline) {
          finish();
          return;
        }
        const composer = document.querySelector(CODEX_COMPOSER_SELECTOR);
        if (!composer) return;
        const selected = composer
          .querySelector(":scope > [data-above-composer-portal]")
          ?.getAttribute("data-above-composer-conversation-id");
        // Already restored, or a different Thread was explicitly opened.
        if (selected) {
          finish();
          return;
        }
        opening = true;
        void openRendererThread(view.threadId, { hostId: "local", signal: controller.signal })
          .catch(() => {
            if (!controller.signal.aborted)
              console.warn(
                "codexhost: Could not restore the selected Thread after Account switching",
              );
          })
          .finally(finish);
      };
      const observer = new MutationObserver(restore);
      cancel = finish;
      observer.observe(document.documentElement, { childList: true, subtree: true });
      document.addEventListener("pointerdown", onInput, true);
      document.addEventListener("keydown", onInput, true);
      try {
        const result = await operation();
        committed = true;
        if (!done) {
          // Backend verification must not consume the subsequent UI wait budget.
          deadline = Date.now() + 30_000;
          timer = window.setTimeout(finish, 30_000);
          restore();
        }
        return result;
      } catch (error) {
        finish();
        throw error;
      }
    },
    dispose(): void {
      cancel();
    },
  };
}

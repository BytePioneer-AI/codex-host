import type { HostThreadId } from "@codexhost/shared-contracts";
import type { RendererModelClient } from "./renderer-model-client.js";
import { rendererHarnessMessages } from "./renderer-harness-localization.js";
import type { RendererSettingsLocale } from "./settings/localization.js";

export function createRendererNativeProviderControl(container: Element, onChange: () => void) {
  let dom: {
    root: HTMLDivElement;
    button: HTMLButtonElement;
    status: HTMLSpanElement;
  } | null = null;
  let failed = false;
  let target: { client: RendererModelClient; threadId: HostThreadId } | null = null;
  let providerId: string | null = null;
  let pending = false;
  let checking = false;
  let checkedAt = 0;
  let generation = 0;
  let disposed = false;
  let locale: RendererSettingsLocale = "en";
  const render = (): void => {
    if (!dom) {
      if (!pending && !providerId && !failed) return;
      const root = container.ownerDocument.createElement("div");
      root.setAttribute("data-codexhost-native-provider-continuation", "");
      root.className = "flex items-center gap-2 text-xs";
      const button = container.ownerDocument.createElement("button");
      button.type = "button";
      button.className = "rounded-md px-2 py-1 hover:bg-token-bg-secondary";
      const status = container.ownerDocument.createElement("span");
      status.setAttribute("role", "alert");
      root.append(button, status);
      button.addEventListener("click", onClick);
      dom = { root, button, status };
    }
    const { root, button, status } = dom;
    const messages = rendererHarnessMessages(locale);
    button.textContent = pending
      ? messages.nativeProviderContinuing
      : `${messages.nativeProviderContinue}: ${providerId ?? ""}`;
    button.disabled = pending || !providerId;
    button.title = messages.nativeProviderContinueHint;
    status.textContent = failed ? messages.nativeProviderContinueFailed : "";
    root.hidden = !pending && !providerId && !failed;
    if (!root.isConnected) container.append(root);
  };
  const onClick = (): void => {
    if (disposed || pending || !target || !providerId) return;
    const captured = target;
    const selected = providerId;
    const currentGeneration = ++generation;
    pending = true;
    checking = false;
    failed = false;
    render();
    onChange();
    void (async () => {
      try {
        if (!captured.client.continueNativeWithConfiguredProvider) {
          throw new Error("Native Provider continuation is unavailable");
        }
        await captured.client.continueNativeWithConfiguredProvider(
          { threadId: captured.threadId },
          selected,
        );
        if (disposed || target !== captured || generation !== currentGeneration) return;
        providerId = null;
      } catch (error) {
        console.warn(
          "codexhost native Provider continuation failed",
          error instanceof Error ? error.name : "UnknownError",
        );
        if (disposed || target !== captured || generation !== currentGeneration) return;
        failed = true;
      } finally {
        if (!disposed && target === captured && generation === currentGeneration) {
          pending = false;
          checkedAt = 0;
          render();
          onChange();
        }
      }
    })();
  };
  return {
    get blocked() {
      return pending || failed;
    },
    get pending() {
      return pending;
    },
    update(
      client: RendererModelClient | null,
      threadId: HostThreadId | null,
      eligible: boolean,
      nextLocale: RendererSettingsLocale,
    ) {
      if (disposed) return;
      locale = nextLocale;
      if (target?.client !== client || target?.threadId !== threadId) {
        generation++;
        target = client && threadId ? { client, threadId } : null;
        providerId = null;
        checking = false;
        pending = false;
        checkedAt = 0;
        failed = false;
      }
      if (!eligible && !pending) {
        generation++;
        providerId = null;
        checking = false;
        checkedAt = 0;
        if (dom) dom.root.hidden = true;
        return;
      }
      render();
      if (!eligible || !target || checking || pending || Date.now() - checkedAt < 5000) return;
      const captured = target;
      const currentGeneration = ++generation;
      checking = true;
      checkedAt = Date.now();
      void (async () => {
        try {
          const candidate = await captured.client.inspectNativeProviderContinuation?.({
            threadId: captured.threadId,
          });
          if (disposed || target !== captured || generation !== currentGeneration) return;
          providerId = candidate ?? null;
        } catch (error) {
          if (disposed || target !== captured || generation !== currentGeneration) return;
          providerId = null;
          console.warn(
            "codexhost native Provider continuation could not be verified",
            error instanceof Error ? error.name : "UnknownError",
          );
        } finally {
          if (!disposed && target === captured && generation === currentGeneration) {
            checking = false;
            render();
          }
        }
      })();
    },
    dispose() {
      disposed = true;
      generation++;
      dom?.root.remove();
      dom = null;
      target = null;
    },
  };
}

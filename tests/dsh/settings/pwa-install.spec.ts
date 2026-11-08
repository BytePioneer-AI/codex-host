// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  PwaInstall,
  pwaInstallGuide,
} from "../../../apps/web-ui/packages/client/web/src/pwa-install.ts";
import { PwaInstallRow } from "../../../apps/web-ui/packages/client/ui-codexhost/src/client/PwaInstallRow.tsx";
import { en } from "../../../apps/web-ui/packages/client/ui-codexhost/src/client/locales.ts";

type Choice = { outcome: "accepted" | "dismissed" };
const cleanups: Array<() => void> = [];
let media: EventTarget & { matches: boolean };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("isSecureContext", true);
  media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => media),
  );
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function installation(): PwaInstall {
  const source = new PwaInstall(window);
  cleanups.push(() => source.dispose());
  return source;
}

function offer(outcome: Choice["outcome"] = "dismissed") {
  const choice = Promise.withResolvers<Choice>();
  const prompt = vi.fn(async () => {
    choice.resolve({ outcome });
  });
  const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
    prompt,
    userChoice: choice.promise,
  });
  window.dispatchEvent(event);
  return { event, prompt, choice };
}

function render(source: PwaInstall) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() =>
    root.render(
      createElement(PwaInstallRow, {
        installation: source,
        t: (key: keyof typeof en) => en[key],
      } as ComponentProps<typeof PwaInstallRow>),
    ),
  );
  return container;
}

it.each(["manual", "available"])("keeps the %s row to a title and button", (state) => {
  const source = installation();
  if (state === "available") offer();
  const container = render(source);
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(container.querySelector("button")?.hasAttribute("aria-describedby")).toBe(false);
  expect(container.textContent).toBe(
    en["pwa.title"] + en[state === "available" ? "pwa.install" : "pwa.instructions"],
  );
});

it("retains an offer before Settings mounts and prompts only on a user click", async () => {
  const source = installation();
  const { event, prompt } = offer();
  expect(event.defaultPrevented).toBe(true);
  expect(prompt).not.toHaveBeenCalled();
  const container = render(source);
  const button = container.querySelector("button")!;
  expect(button.textContent).toContain(en["pwa.install"]);
  await act(async () => {
    button.click();
    // The prompt is called synchronously, preserving browser user activation.
    expect(prompt).toHaveBeenCalledOnce();
  });
  expect(container.textContent).toContain(en["pwa.dismissed"]);
  expect(button.textContent).toContain(en["pwa.instructions"]);
  act(() => button.click());
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(container.textContent).toContain(en["pwa.guide.limitations"]);
  expect(prompt).toHaveBeenCalledOnce();
});

it("prevents duplicate prompts, consumes cancelled events and accepts a new offer", async () => {
  const source = installation();
  const { prompt, choice } = offer();
  prompt.mockImplementation(() => Promise.resolve());
  const pending = source.install();
  expect(source.store.getSnapshot()).toBe("prompting");
  await source.install();
  expect(prompt).toHaveBeenCalledOnce();
  choice.resolve({ outcome: "dismissed" });
  await pending;
  await source.install();
  expect(prompt).toHaveBeenCalledOnce();
  offer();
  expect(source.store.getSnapshot()).toBe("available");
});

it("does not equate acceptance with completed installation", async () => {
  const source = installation();
  offer("accepted");
  await source.install();
  expect(source.store.getSnapshot()).toBe("accepted");
  window.dispatchEvent(new Event("appinstalled"));
  expect(source.store.getSnapshot()).toBe("installed");
  expect(render(source).querySelector("button")).toBeNull();
  expect(offer().event.defaultPrevented).toBe(false);
});

it("keeps confirmed installation when userChoice settles later", async () => {
  const source = installation();
  const { prompt, choice } = offer();
  prompt.mockImplementation(() => Promise.resolve());
  const pending = source.install();
  window.dispatchEvent(new Event("appinstalled"));
  choice.resolve({ outcome: "accepted" });
  await pending;
  expect(source.store.getSnapshot()).toBe("installed");
});

it.each(["reject", "throw"])(
  "handles prompt failure (%s) without reusing the event",
  async (mode) => {
    const source = installation();
    const { prompt } = offer();
    prompt.mockImplementation(() => {
      if (mode === "throw") throw new Error("NotAllowedError");
      return Promise.reject(new Error("NotAllowedError"));
    });
    await source.install();
    expect(source.store.getSnapshot()).toBe("failed");
    await source.install();
    expect(prompt).toHaveBeenCalledOnce();
    const container = render(source);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(en["pwa.failed"]);
  },
);

it("detaches listeners and ignores a pending completion after disposal", async () => {
  const source = installation();
  const { prompt, choice } = offer();
  prompt.mockImplementation(() => Promise.resolve());
  const pending = source.install();
  source.dispose();
  choice.resolve({ outcome: "accepted" });
  await pending;
  expect(source.store.getSnapshot()).toBe("prompting");
  expect(offer().event.defaultPrevented).toBe(false);
  window.dispatchEvent(new Event("appinstalled"));
  media.matches = true;
  media.dispatchEvent(new Event("change"));
  expect(source.store.getSnapshot()).toBe("prompting");
});

it("recognizes standalone launch and display-mode changes", () => {
  media.matches = true;
  const source = installation();
  expect(source.store.getSnapshot()).toBe("installed");
  media.matches = false;
  media.dispatchEvent(new Event("change"));
  expect(source.store.getSnapshot()).toBe("manual");
  media.matches = true;
  media.dispatchEvent(new Event("change"));
  expect(source.store.getSnapshot()).toBe("installed");
});

it("recognizes iOS standalone launch", () => {
  Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
  cleanups.push(() => Reflect.deleteProperty(navigator, "standalone"));
  expect(installation().store.getSnapshot()).toBe("installed");
});

it("shows secure-context guidance without trying to install on plain HTTP", () => {
  vi.stubGlobal("isSecureContext", false);
  const source = installation();
  expect(source.guide).toBe("insecure");
  const { event, prompt } = offer();
  expect(event.defaultPrevented).toBe(false);
  const container = render(source);
  expect(container.textContent).toContain(en["pwa.guide.insecure"]);
  act(() => container.querySelector("button")!.click());
  expect(prompt).not.toHaveBeenCalled();
  expect(container.textContent).toContain(en["pwa.guide.limitations"]);
  expect(container.textContent?.split(en["pwa.guide.insecure"])).toHaveLength(2);
});

it("updates an open Settings row when installation becomes available", async () => {
  const source = installation();
  const container = render(source);
  const button = container.querySelector("button")!;
  act(() => button.click());
  expect(button.getAttribute("aria-expanded")).toBe("true");
  act(() => {
    offer("accepted");
  });
  expect(button.textContent).toContain(en["pwa.install"]);
  await act(async () => button.click());
  expect(container.textContent).toContain(en["pwa.accepted"]);
  expect(container.textContent).not.toContain(en["pwa.guide.limitations"]);
  act(() => window.dispatchEvent(new Event("appinstalled")));
  expect(container.querySelector("button")).toBeNull();
});

it.each([
  ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit Safari", 5, "ios"],
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit Safari", 5, "ios"],
  ["Mozilla/5.0 (Linux; Android 14) AppleWebKit Chrome Safari", 5, "android"],
  ["Mozilla/5.0 (Android 14) Gecko Firefox", 5, "android"],
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit Version/17.0 Safari", 0, "safari"],
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit Chrome Safari", 0, "browser"],
  ["Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome Safari Edg/130.0", 0, "browser"],
  ["Mozilla/5.0 (X11; Linux x86_64) Gecko Firefox", 0, "browser"],
])("selects manual guidance for %s", (userAgent, maxTouchPoints, expected) => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent as string);
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: maxTouchPoints });
  cleanups.push(() => Reflect.deleteProperty(navigator, "maxTouchPoints"));
  expect(pwaInstallGuide(window)).toBe(expected);
  const source = installation();
  const container = render(source);
  act(() => container.querySelector("button")!.click());
  expect([...container.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
    en["pwa.guide.limitations"],
    en[`pwa.guide.${source.guide}`],
  ]);
});

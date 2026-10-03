import { afterEach, describe, expect, it, vi } from "vitest";
import { createRendererCodexUsageBanner } from "../src/renderer-codex-usage-banner.js";

function fixture(type: unknown = "prolite_rate_limit_reached") {
  const attributes = new Map<string, string>();
  const styles = new Map<string, { value: string; priority: string }>();
  const banner = { banner_type: type, title: "Localized quota notice", reset_at: 1791090073 };
  const props = { banner };
  const owner = { memoizedProps: props, return: null };
  const element = {
    hidden: false as HTMLElement["hidden"],
    closest: () => composer,
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: vi.fn((name: string, value: string) => attributes.set(name, value)),
    removeAttribute: (name: string) => attributes.delete(name),
    style: {
      getPropertyValue: (name: string) => styles.get(name)?.value ?? "",
      getPropertyPriority: (name: string) => styles.get(name)?.priority ?? "",
      setProperty: vi.fn((name: string, value: string, priority = "") =>
        styles.set(name, { value, priority }),
      ),
      removeProperty: (name: string) => styles.delete(name),
    },
    __reactFiber$test: { memoizedProps: { role: "status" }, return: owner },
  };
  const elements = [element];
  let mutated: (() => void) | null = null;
  const observe = vi.fn();
  const disconnect = vi.fn();
  class Observer {
    constructor(callback: () => void) {
      mutated = callback;
    }
    observe = observe;
    disconnect = disconnect;
  }
  const composer = {
    isConnected: true,
    querySelectorAll: vi.fn(() => elements),
    ownerDocument: { defaultView: { MutationObserver: Observer } },
  };
  return {
    element,
    elements,
    composer,
    banner,
    owner,
    observe,
    disconnect,
    mutate: () => mutated?.(),
    view: createRendererCodexUsageBanner(composer as unknown as Element),
  };
}

describe("Composer-local Codex quota banner", () => {
  it.each(["rate_limit_reached", "prolite_rate_limit_reached", "plus_rate_limit_reached"])(
    "hides %s only after a verified quota bypass",
    (type) => {
      const f = fixture(type);
      f.view.update(false);
      expect(f.element.hidden).toBe(false);
      f.view.update(true);
      expect(f.element.hidden).toBe(true);
      expect(f.element.getAttribute("aria-hidden")).toBe("true");
      expect(f.element.style.getPropertyValue("display")).toBe("none");
      expect(f.element.style.getPropertyPriority("display")).toBe("important");
      expect(f.banner).toEqual({
        banner_type: type,
        title: "Localized quota notice",
        reset_at: 1791090073,
      });
    },
  );

  it.each(["ultra_warning", "image_generation_limit", "rate_limit_warning", "", null])(
    "keeps unrelated or unknown banner %s visible",
    (type) => {
      const f = fixture(type);
      f.view.update(true);
      expect(f.element.hidden).toBe(false);
      expect(f.element.style.setProperty).not.toHaveBeenCalled();
    },
  );

  it("does not guess from localized text or recovery actions without a banner discriminator", () => {
    const f = fixture();
    Object.assign(f.owner, {
      memoizedProps: {
        title: "You're out of Codex and Work usage",
        variant: "recovery",
        customCtas: { key: "reset_usage:0" },
      },
    });
    f.view.update(true);
    expect(f.element.hidden).toBe(false);
  });

  it("restores original display, priority and accessibility when the bypass is revoked", () => {
    const f = fixture();
    f.element.style.setProperty("display", "flex", "important");
    f.element.setAttribute("aria-hidden", "false");
    f.view.update(true);
    f.view.update(false);
    expect(f.element.hidden).toBe(false);
    expect(f.element.getAttribute("aria-hidden")).toBe("false");
    expect(f.element.style.getPropertyValue("display")).toBe("flex");
    expect(f.element.style.getPropertyPriority("display")).toBe("important");
  });

  it("is idempotent while native React rerenders keep the same banner", () => {
    const f = fixture();
    f.view.update(true);
    f.view.update(true);
    expect(f.element.setAttribute).toHaveBeenCalledTimes(1);
    expect(f.element.style.setProperty).toHaveBeenCalledTimes(1);
    f.element.hidden = false;
    f.element.style.removeProperty("display");
    f.view.update(true);
    expect(f.element.hidden).toBe(true);
    expect(f.element.style.getPropertyValue("display")).toBe("none");
    f.view.dispose();
    expect(f.element.hidden).toBe(false);
    expect(f.element.style.getPropertyValue("display")).toBe("");
  });

  it("restores a replaced node and hides the replacement only within this Composer", () => {
    const first = fixture();
    const replacement = fixture();
    replacement.element.closest = () => first.composer;
    first.view.update(true);
    first.elements.splice(0, 1, replacement.element);
    first.view.update(true);
    expect(first.element.hidden).toBe(false);
    expect(replacement.element.hidden).toBe(true);
    first.view.dispose();
    expect(replacement.element.hidden).toBe(false);
  });

  it("restores a reused DOM node when it becomes a different native warning", () => {
    const f = fixture();
    f.view.update(true);
    f.banner.banner_type = "image_generation_limit";
    f.view.update(true);
    expect(f.element.hidden).toBe(false);
    expect(f.element.getAttribute("aria-hidden")).toBeNull();
    expect(f.element.style.getPropertyValue("display")).toBe("");
  });

  it("leaves another Composer and its quota state unchanged", () => {
    const first = fixture();
    const other = fixture();
    first.elements.push(other.element);
    first.view.update(true);
    expect(first.element.hidden).toBe(true);
    expect(other.element.hidden).toBe(false);
  });

  it("does not overwrite native changes on release", () => {
    const f = fixture();
    f.view.update(true);
    f.element.hidden = "until-found";
    f.element.setAttribute("aria-hidden", "false");
    f.element.style.setProperty("display", "grid");
    f.view.dispose();
    expect(f.element.hidden).toBe("until-found");
    expect(f.element.getAttribute("aria-hidden")).toBe("false");
    expect(f.element.style.getPropertyValue("display")).toBe("grid");
  });

  it("restores disconnected Composers and preserves originally hidden banners", () => {
    const f = fixture();
    f.element.hidden = true;
    f.view.update(true);
    f.composer.isConnected = false;
    f.view.update(true);
    expect(f.element.hidden).toBe(true);
    expect(f.element.style.getPropertyValue("display")).toBe("");
  });

  it("reads the published React tree instead of a stale DOM fiber", () => {
    const f = fixture();
    const currentOwner = {
      memoizedProps: { banner: { banner_type: "image_generation_limit" } },
      child: {},
    };
    const currentElement = { memoizedProps: {}, return: currentOwner };
    currentOwner.child = currentElement;
    const currentRoot = { child: currentOwner };
    Object.assign(f.owner, { return: { stateNode: { current: currentRoot } } });
    Object.assign(f.element.__reactFiber$test, { alternate: currentElement });
    f.view.update(true);
    expect(f.element.hidden).toBe(false);
  });
});

afterEach(() => vi.restoreAllMocks());

describe("Before-paint native banner reconciliation", () => {
  it("hides a late native banner without waiting for a Composer render or animation frame", () => {
    const f = fixture();
    const element = f.elements.pop();
    if (!element) throw new Error("Missing fixture banner");
    f.view.update(true);
    expect(f.observe).toHaveBeenCalledTimes(1);
    f.elements.push(element);
    f.mutate();
    expect(element.hidden).toBe(true);
    expect(element.style.getPropertyValue("display")).toBe("none");
    f.view.dispose();
  });

  it("reapplies hiding after React overwrites styles before the next paint", () => {
    const f = fixture();
    f.view.update(true);
    f.element.hidden = false;
    f.element.removeAttribute("aria-hidden");
    f.element.style.removeProperty("display");
    f.mutate();
    expect(f.element.hidden).toBe(true);
    expect(f.element.getAttribute("aria-hidden")).toBe("true");
    expect(f.element.style.getPropertyValue("display")).toBe("none");
    f.view.dispose();
  });

  it("does not form an observer write loop or revive hiding after revocation/disposal", () => {
    const f = fixture();
    f.view.update(true);
    f.mutate();
    f.mutate();
    expect(f.element.style.setProperty).toHaveBeenCalledTimes(1);
    f.view.update(false);
    f.mutate();
    expect(f.element.hidden).toBe(false);
    f.view.dispose();
    f.view.update(true);
    f.mutate();
    expect(f.element.hidden).toBe(false);
    expect(f.disconnect).toHaveBeenCalled();
  });
});

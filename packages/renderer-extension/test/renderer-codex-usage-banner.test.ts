import { describe, expect, it } from "vitest";
import {
  createRendererCodexUsageBanner,
  inspectCodexUsageBanners,
} from "../src/renderer-codex-usage-banner.js";

type Fiber = { memoizedProps?: unknown; return?: unknown };

/** CSSStyleDeclaration double for the single property the controller writes. */
class FakeStyle {
  display = "";
}

/** Minimal Element double: only the surface the banner controller touches. */
class FakeAside {
  readonly tagName = "ASIDE";
  readonly attributes = new Map<string, string>();
  readonly style = new FakeStyle();
  readonly fiber: Fiber | null;
  constructor(fiber: Fiber | null, ariaLive = true) {
    this.fiber = fiber;
    if (ariaLive) this.attributes.set("aria-live", "polite");
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  get hidden(): boolean {
    return this.style.display === "none";
  }
}

// The controller reads the fiber through the element's own property names,
// like React DOM's __reactFiber$ keys; fixtures define it per instance.

/** Minimal ParentNode double collecting the live set of asides. */
class FakeRoot {
  constructor(private readonly asides: FakeAside[]) {}
  querySelectorAll(selector: string): FakeAside[] {
    if (selector === "aside[aria-live]") {
      return this.asides.filter((aside) => aside.hasAttribute("aria-live"));
    }
    if (selector.startsWith("aside[data-codexhost-usage-banner-hidden")) {
      return this.asides.filter((aside) =>
        aside.hasAttribute("data-codexhost-usage-banner-hidden"),
      );
    }
    return [];
  }
}

/**
 * Desktop's banner tree: the `<aside aria-live>` shell rendered by a
 * presentational component, owned above by the banner component carrying the
 * server payload as `props.banner`.
 */
function bannerFixture(type: string | null, ownerProps?: Record<string, unknown>) {
  const bannerPayload = type === null ? {} : { banner_type: type, title: "quota", ctas: [] };
  const owner: Fiber = { memoizedProps: ownerProps ?? { banner: bannerPayload } };
  const shell: Fiber = { memoizedProps: { variant: "warning", title: "quota" }, return: owner };
  const aside = new FakeAside(shell);
  // Own property, like React DOM hosts it; the controller finds the fiber via
  // Object.getOwnPropertyNames, which does not see prototype getters.
  Object.defineProperty(aside, "__reactFiber$test", {
    value: shell,
    enumerable: false,
    configurable: true,
  });
  return { aside, owner, shell };
}

function controlFor(asides: FakeAside[]) {
  const root = new FakeRoot(asides);
  return {
    root,
    control: createRendererCodexUsageBanner(root as unknown as ParentNode),
  };
}

describe("Codex usage banner hiding for external Harness Composers", () => {
  it("hides only usage-quota banners while an external Harness is ready", () => {
    const f = bannerFixture("pro_rate_limit_reached");
    const { root, control } = controlFor([f.aside]);
    expect(inspectCodexUsageBanners(root as unknown as ParentNode)).toEqual({
      usageBannerCount: 1,
    });
    expect(f.aside.hidden).toBe(false);

    control.update(true);
    expect(f.aside.hidden).toBe(true);
    expect(f.aside.hasAttribute("data-codexhost-usage-banner-hidden")).toBe(true);

    control.update(false);
    expect(f.aside.hidden).toBe(false);
    expect(f.aside.hasAttribute("data-codexhost-usage-banner-hidden")).toBe(false);
  });

  it("keeps unrelated banners visible", () => {
    for (const type of ["image_generation_limit_reached", "invite", "some_new_banner"]) {
      const f = bannerFixture(type);
      const { control } = controlFor([f.aside]);
      control.update(true);
      expect(f.aside.hidden).toBe(false);
    }
  });

  it("keeps banners without a typed ancestor visible", () => {
    const f = bannerFixture(null);
    const { control } = controlFor([f.aside]);
    control.update(true);
    expect(f.aside.hidden).toBe(false);
  });

  it("re-applies to banners mounted after the last update", () => {
    const first = bannerFixture("rate_limit");
    const asides = [first.aside];
    const { root, control } = controlFor(asides);
    control.update(true);
    expect(first.aside.hidden).toBe(true);

    const next = bannerFixture("luna_reserve");
    asides.push(next.aside);
    control.refresh();
    expect(next.aside.hidden).toBe(true);
    expect(inspectCodexUsageBanners(root as unknown as ParentNode)).toEqual({
      usageBannerCount: 2,
    });

    control.update(false);
    expect(first.aside.hidden).toBe(false);
    expect(next.aside.hidden).toBe(false);
  });

  it("ignores asides that render other features", () => {
    const plain = new FakeAside(null);
    const { root, control } = controlFor([plain]);
    control.update(true);
    expect(plain.hidden).toBe(false);
    expect(inspectCodexUsageBanners(root as unknown as ParentNode)).toEqual({
      usageBannerCount: 0,
    });
  });

  it("restores banners on dispose", () => {
    const f = bannerFixture("rate_limit");
    const { control } = controlFor([f.aside]);
    control.update(true);
    expect(f.aside.hidden).toBe(true);
    control.dispose();
    expect(f.aside.hidden).toBe(false);
  });

  it("reads the banner type from spread props as well", () => {
    const f = bannerFixture(null, { banner_type: "rate_limit", title: "quota" });
    const { control } = controlFor([f.aside]);
    control.update(true);
    expect(f.aside.hidden).toBe(true);
  });
});

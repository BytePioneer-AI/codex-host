import { describe, expect, it } from "vitest";
import {
  createRendererCodexUsageBanner,
  findCodexUsageBannerElements,
} from "../src/renderer-codex-usage-banner.js";

function element(display = "") {
  const attributes = new Map<string, string>();
  const props = new Map<string, [string, string]>();
  if (display) props.set("display", [display, ""]);
  return {
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    getAttribute: (name: string) => attributes.get(name) ?? null,
    removeAttribute: (name: string) => attributes.delete(name),
    style: {
      getPropertyValue: (name: string) => props.get(name)?.[0] ?? "",
      getPropertyPriority: (name: string) => props.get(name)?.[1] ?? "",
      setProperty: (name: string, value: string, priority = "") =>
        props.set(name, [value, priority]),
      removeProperty: (name: string) => props.delete(name),
    },
    display: () => props.get("display")?.[0] ?? "",
  };
}

type Node = {
  memoizedProps?: unknown;
  child?: Node | null;
  sibling?: Node | null;
  stateNode?: unknown;
};

/** owner -> other -> banner(component) -> host aside (-> nested host). */
function tree(
  bannerProps: Record<string, unknown> = { banner: {}, rateLimitStatus: {}, sendBlocked: true },
) {
  const aside = element();
  const nested = element();
  const other = element();
  const bannerHost: Node = { stateNode: aside, child: { stateNode: nested } };
  const banner: Node = { memoizedProps: bannerProps, child: { child: bannerHost } };
  const unrelated: Node = { memoizedProps: { banner: {} }, child: { stateNode: other } };
  const owner: Node = { child: { child: unrelated, sibling: banner } };
  return { owner, banner, aside, nested, other };
}

describe("Codex usage banner in external Harness Composers", () => {
  it("finds only the outermost host elements of the usage banner", () => {
    const t = tree();
    expect(findCodexUsageBannerElements(t.owner)).toEqual([t.aside]);
    expect(findCodexUsageBannerElements(tree({ banner: {}, sendBlocked: true }).owner)).toEqual([]);
    expect(findCodexUsageBannerElements(null)).toEqual([]);
  });

  it("hides and restores the banner's inline display without touching others", () => {
    const t = tree();
    t.aside.style.setProperty("display", "flex");
    const banner = createRendererCodexUsageBanner();
    banner.hide(t.owner);
    expect(t.aside.display()).toBe("none");
    expect(t.aside.style.getPropertyPriority("display")).toBe("important");
    expect(t.other.display()).toBe("");
    banner.hide(t.owner);
    banner.restore();
    expect(t.aside.display()).toBe("flex");
    expect(t.aside.getAttribute("data-codexhost-usage-banner-hidden")).toBeNull();
  });

  it("restores a banner that leaves the owner's subtree", () => {
    const t = tree();
    const banner = createRendererCodexUsageBanner();
    banner.hide(t.owner);
    expect(t.aside.display()).toBe("none");
    t.banner.memoizedProps = {};
    banner.hide(t.owner);
    expect(t.aside.display()).toBe("");
  });
});

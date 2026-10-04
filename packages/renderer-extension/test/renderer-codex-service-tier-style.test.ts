import { describe, expect, it } from "vitest";

import {
  CODEX_SERVICE_TIER_BOLT_PATHS,
  CODEX_SERVICE_TIER_STYLE_ATTRIBUTE,
  codexServiceTierStyleText,
  installCodexServiceTierStyle,
} from "../src/renderer-codex-service-tier-style.js";

class FakeHead {
  readonly children: FakeStyleElement[] = [];
  append(...elements: FakeStyleElement[]): void {
    for (const element of elements) {
      element.owner = this;
      this.children.push(element);
    }
  }
}

class FakeStyleElement {
  readonly attributes = new Map<string, string>();
  textContent = "";
  owner: FakeHead | null = null;
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  remove(): void {
    if (!this.owner) return;
    const index = this.owner.children.indexOf(this);
    if (index >= 0) this.owner.children.splice(index, 1);
    this.owner = null;
  }
}

/** Minimal Document stand-in exposing only what installCodexServiceTierStyle uses. */
function fakeDocument(): { document: Document; head: FakeHead } {
  const head = new FakeHead();
  const document = {
    head,
    createElement: (tag: string) => {
      if (tag !== "style") throw new Error(`unexpected createElement(${tag})`);
      return new FakeStyleElement();
    },
    querySelector: (selector: string) => {
      const match = /^style\[([^\]]+)\]$/.exec(selector);
      if (!match) return null;
      const attribute = match[1];
      return (
        head.children.find((child) => attribute !== undefined && child.attributes.has(attribute)) ??
        null
      );
    },
  } as unknown as Document;
  return { document, head };
}

describe("Codex service-tier stylesheet", () => {
  it("scopes both tiers to the local ownership scope and the official slider identifiers", () => {
    const css = codexServiceTierStyleText();
    expect(css).toContain('[data-codexhost-service-tier-scope="fast"]');
    expect(css).toContain('[data-codexhost-service-tier-scope="ultrafast"]');
    // The presence rule keys on the scope attribute alone.
    expect(css).toContain("[data-codexhost-service-tier-scope]\n  :is(");
    expect(css).toContain("[data-model-picker-power-slider]");
    expect(css).toContain('[data-fast-mode="false"][data-reduced-motion="false"]');
    // Particles ride the official blue _Range_ fill so both the track clip and
    // the fill's own width/offset bound them to the selected range.
    expect(css).toContain('[class*="_Range_"]::after');
    expect(css).toContain('[class*="_Range_"]::before');
    expect(css).toContain("@media (prefers-reduced-motion: no-preference)");
    expect(css).toContain("@keyframes codexhost-service-tier-particle-drift");
    expect(css).toContain("translateX(150px)");
    // The global Host-confirmed marker (<html data-codexhost-service-tier>) is
    // a state contract only: no rule may key on it any more.
    expect(css).not.toContain("html[data-codexhost-service-tier");
  });

  it("paints the trigger bolt into the official icon slot from the local scope only", () => {
    const css = codexServiceTierStyleText();
    // Keyed on the scope attribute the local tier control stamps, so it appears
    // exactly while a confirmed tier belongs to that local Composer and never
    // on a remote Host's Composer.
    expect(css).toContain("[data-codexhost-service-tier-scope]");
    expect(css).toContain("[data-codex-intelligence-trigger]");
    // Both official trigger shapes are covered: the labelled inline-icon group
    // and the compact tabular-nums row (excluding the group's own subtree, so
    // exactly one element ever matches).
    expect(css).toContain('[class*="ModelPickerTriggerModelGroup"]');
    expect(css).toContain('[class~="tabular-nums"]:not([class*="ModelPickerTriggerModelGroup"] *)');
    expect(css).toContain("::before {");
    // Official geometry: the 14px inline-mode-icon size.
    expect(css).toMatch(/::before \{[\s\S]*?width: 14px;[\s\S]*?height: 14px;/u);
    // The Desktop shows the Daybreak sun in this same slot, so the bolt yields.
    expect(css).toContain(":not(:has([data-daybreak-indicator]))");
    // The button and the flyout leave with the panel the Desktop swaps away.
    expect(css).toContain(
      '[class*="ViewTrack"][aria-hidden="true"] [data-codexhost-service-tier-toggle]',
    );
    expect(css).toContain('[class*="ViewTrack"][inert] [data-codexhost-service-tier-toggle]');
    // Both tiers get their own official glyph through a mask, never text.
    expect(css).toContain('[data-codexhost-service-tier-scope="fast"]');
    expect(css).toContain('[data-codexhost-service-tier-scope="ultrafast"]');
    expect(css).toContain('mask-image: url("data:image/svg+xml,');
    expect(css).toContain('-webkit-mask-image: url("data:image/svg+xml,');
  });

  it("styles the official 32px speed button and its 233px flyout", () => {
    const css = codexServiceTierStyleText();
    // The official `_FastModeToggle_` box: 32px wide, absolutely placed at the
    // row's inline start, 26px content square, 16px icon.
    expect(css).toMatch(
      /\[data-codexhost-service-tier-toggle\] \{[\s\S]*?position: absolute;[\s\S]*?inset-inline-start: 0;[\s\S]*?width: 32px;[\s\S]*?min-height: 32px;/u,
    );
    expect(css).toMatch(
      /\[data-codexhost-service-tier-toggle-content\] \{[\s\S]*?width: 26px;[\s\S]*?height: 26px;/u,
    );
    expect(css).toMatch(
      /\[data-codexhost-service-tier-toggle-content\] > svg \{[\s\S]*?width: 16px;[\s\S]*?height: 16px;/u,
    );
    // The official row reserves the same 16px inline padding for it.
    expect(css).toContain(
      '[class*="ViewControls"]:has([data-codexhost-service-tier-toggle]) {\n  padding-inline: 16px;',
    );
    // Official color pair: tertiary at rest, the chart blue while active.
    expect(css).toContain(
      '[data-codexhost-service-tier-toggle][data-fast-mode-enabled="true"] {\n  color: var(--color-chart-blue',
    );
    // The official `[data-explicit-model=true]` padding rule must still win:
    // the codexhost rule is restated after the generic one at the same
    // specificity, and the official `:before` spacer keeps its own rule.
    const generic = css.indexOf(
      '[class*="ViewControls"]:has([data-codexhost-service-tier-toggle]) {\n  padding-inline: 16px;',
    );
    const explicit = css.indexOf(
      '[class*="ViewControls"][data-explicit-model="true"]:has([data-codexhost-service-tier-toggle])',
    );
    expect(generic).toBeGreaterThan(-1);
    expect(explicit).toBeGreaterThan(generic);
    expect(css).toContain("padding-inline: calc(var(--spacing, 4px) * 8);");
    // The official explicit-model layout also pins the side controls to the top.
    expect(css).toContain(
      '[class*="ViewControls"][data-explicit-model="true"] [data-codexhost-service-tier-toggle] {\n  inset-block-start: 0;',
    );
    // Border-box keeps the rendered 32px / 26px / 233px boxes exact.
    expect(css).toMatch(
      /\[data-codexhost-service-tier-toggle\] \{[\s\S]*?box-sizing: border-box;/u,
    );
    expect(css).toMatch(
      /\[data-codexhost-service-tier-toggle-content\] \{[\s\S]*?box-sizing: border-box;/u,
    );
    expect(css).toMatch(
      /\[data-codexhost-service-tier-flyout\] \{[\s\S]*?box-sizing: border-box;/u,
    );
    // The flyout is a top-layer popover, so no menu overflow can clip it.
    expect(css).toMatch(
      /\[data-codexhost-service-tier-flyout\] \{[\s\S]*?position: fixed;[\s\S]*?width: 233px;/u,
    );
    expect(css).toContain("[data-codexhost-service-tier-flyout]:not(:popover-open)");
    expect(css).toContain("[data-codexhost-service-tier-option]");
    expect(css).toContain('[data-codexhost-service-tier-option-check][data-checked="false"]');
    expect(css).toContain("visibility: hidden;");
    // The official selected-row check renders at its resource canvas.
    expect(css).toMatch(/\[data-codexhost-service-tier-option-check\] \{[\s\S]*?width: 17px;/u);
    expect(css).toContain("var(--color-codex-description");
    // The old row-above-list surface is gone entirely.
    expect(css).not.toContain("[data-codexhost-service-tier-row");
    expect(css).not.toContain("[data-codexhost-service-tier-list]");
    expect(css).not.toContain("[data-codexhost-service-tier-panel]");
  });

  it("keeps the forced-colors focus ring last, so no shorthand resets it", () => {
    const css = codexServiceTierStyleText();
    // `@media (forced-colors: active)` comes after every focus rule; the
    // option's own `outline` shorthand would otherwise win at equal specificity
    // and reset the CanvasText color.
    const focusShorthand = css.indexOf(
      "[data-codexhost-service-tier-option]:focus-visible {\n  outline: 2px solid var(--color-token-border",
    );
    const forcedColors = css.indexOf("@media (forced-colors: active)");
    expect(focusShorthand).toBeGreaterThan(-1);
    expect(forcedColors).toBeGreaterThan(focusShorthand);
    expect(css.indexOf("[data-codexhost-service-tier-toggle]:focus-visible {", forcedColors)).toBe(
      -1,
    );
    expect(css.slice(forcedColors)).toContain("outline-color: CanvasText;");
    // The media block ends the stylesheet: only whitespace follows its closing
    // braces, so no later rule can reset those rings.
    expect(css.trimEnd().endsWith("outline-color: CanvasText;\n  }\n}")).toBe(true);
    expect(css.indexOf("@media", forcedColors + 1)).toBe(-1);
  });

  it("exposes both tier icons for the Composer surfaces", () => {
    // Fast is the official 20-unit trigger glyph; Ultrafast is the 22-unit one.
    expect(CODEX_SERVICE_TIER_BOLT_PATHS.fast.viewBox).toBe("0 0 20 20");
    expect(CODEX_SERVICE_TIER_BOLT_PATHS.ultrafast.viewBox).toBe("-1 -1 22 22");
    expect(CODEX_SERVICE_TIER_BOLT_PATHS.fast.d).not.toBe(
      CODEX_SERVICE_TIER_BOLT_PATHS.ultrafast.d,
    );
    expect(CODEX_SERVICE_TIER_BOLT_PATHS.fast.d.startsWith("M")).toBe(true);
  });

  it("injects one stylesheet per document and removes it on dispose", () => {
    const { document, head } = fakeDocument();
    const disposeFirst = installCodexServiceTierStyle(document);
    const disposeSecond = installCodexServiceTierStyle(document);

    expect(head.children).toHaveLength(1);
    const style = head.children[0];
    expect(style).toBeDefined();
    expect(style?.attributes.get(CODEX_SERVICE_TIER_STYLE_ATTRIBUTE)).toBe("true");
    expect(style?.textContent).toBe(codexServiceTierStyleText());

    disposeFirst();
    expect(head.children).toHaveLength(0);
    expect(() => disposeSecond()).not.toThrow();
  });

  it("reinstalls cleanly after dispose", () => {
    const { document, head } = fakeDocument();
    const dispose = installCodexServiceTierStyle(document);
    dispose();
    const reinstall = installCodexServiceTierStyle(document);
    expect(head.children).toHaveLength(1);
    reinstall();
    expect(head.children).toHaveLength(0);
  });

  it("tolerates partial Document mocks without throwing", () => {
    const partials: unknown[] = [{}, { documentElement: {} }, { querySelector: () => null }];
    for (const partial of partials) {
      const dispose = installCodexServiceTierStyle(partial as Document);
      expect(() => dispose()).not.toThrow();
    }
  });
});

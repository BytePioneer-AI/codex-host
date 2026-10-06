/**
 * Pure-CSS reinforcements for the Codex request tier (Standard / Fast / Ultrafast).
 *
 * Paints only inside scope elements the local tier control itself marks with
 * `data-codexhost-service-tier-scope` (renderer-codex-service-tier-bolt.ts):
 * the local Composer root for the trigger bolt and the official menu portal
 * the local control owns for the slider particles. A remote Host Composer,
 * an external Harness, or a switching Composer is never marked, so it cannot
 * inherit the accent. Standard is a scope value too: the trigger bolt stays in
 * the official resting color and no particle layer is keyed on it, so a
 * Standard selection paints nothing beyond the resting glyph. The `<html
 * data-codexhost-service-tier>` attribute remains the Host-confirmed state
 * contract the probe reads; no CSS keys on it, and this module never writes
 * any attribute. No MutationObserver, no per-frame JS, no DOM scans.
 *
 * Two surfaces are drawn here, both from the same stylesheet:
 * 1. Particles on the official reasoning-power slider (`data-model-picker-power-slider`),
 *    a two-tone dot field drifting right to left inside the official blue
 *    `_Range_` fill, so the field is clipped to the selected range exactly like
 *    the official FastTrackParticles clip-path (which the Desktop recomputes in
 *    JS). Only transform animates.
 * 2. The speed button and 233px tier flyout injected into the official model
 *    menu by renderer-codex-service-tier-bolt.ts, styled from their
 *    `[data-codexhost-service-tier-*]` attributes at the end of this sheet.
 *    The flyout itself is a top-layer popover; only its surface is styled here.
 *
 * Deployment identifiers this file depends on are listed on each rule below
 * (all verified against the unpacked Desktop 26.928 assets; hashed class names
 * are matched by fragment only).
 */

import type { CodexServiceTierId } from "@codexhost/shared-contracts";

export const CODEX_SERVICE_TIER_STYLE_ATTRIBUTE = "data-codexhost-service-tier-style";

/**
 * The scope attribute the tier control writes onto local-owned elements: the
 * local Composer root and its official menu portal. This is the only marker
 * the CSS below keys on, so a confirmed tier can never paint a surface the
 * local control does not own.
 */
export const CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE = "data-codexhost-service-tier-scope";

/**
 * Official Fast gear icon, exactly as bundled: `vU` at viewBox 0 0 20 20
 * (app-primary, `M9.80999 17.8302…`), the glyph the Desktop renders at 14px
 * through its `ModelPickerTriggerInlineModeIcon` class.
 */
const FAST_BOLT_PATH =
  "M9.80999 17.8302C9.49666 18.1969 9.08999 18.3869 8.58999 18.4002C8.09666 18.4136 7.69666 18.2436 7.38999 17.8902C7.08999 17.5436 7.02666 17.0636 7.19999 16.4502L8.06999 13.2902H3.89999C3.43333 13.2902 3.06999 13.1602 2.80999 12.9002C2.55666 12.6336 2.42999 12.3136 2.42999 11.9402C2.42999 11.5602 2.55666 11.2169 2.80999 10.9102L10.16 2.18022C10.4733 1.81356 10.8767 1.62356 11.37 1.61022C11.87 1.59689 12.27 1.76689 12.57 2.12022C12.8767 2.47356 12.9433 2.95356 12.77 3.56023L11.87 6.78023H16.05C16.51 6.78023 16.87 6.91356 17.13 7.18023C17.3967 7.44023 17.53 7.76023 17.53 8.14023C17.53 8.52023 17.4 8.86023 17.14 9.16023L9.80999 17.8302ZM15.89 8.50023C15.93 8.44689 15.95 8.39356 15.95 8.34023C15.9567 8.28689 15.94 8.24356 15.9 8.21023C15.86 8.17023 15.8033 8.15023 15.73 8.15023H11.1C10.9133 8.15023 10.7533 8.10356 10.62 8.01023C10.4933 7.91689 10.4067 7.79023 10.36 7.63023C10.3133 7.47023 10.3167 7.29023 10.37 7.09023L11.33 3.62022C11.3567 3.52022 11.3467 3.44356 11.3 3.39022C11.2533 3.33022 11.19 3.30356 11.11 3.31022C11.0367 3.31689 10.9733 3.35356 10.92 3.42023L4.04999 11.5702C4.00999 11.6236 3.98666 11.6769 3.97999 11.7302C3.97999 11.7836 3.99999 11.8269 4.03999 11.8602C4.07999 11.8936 4.13999 11.9102 4.21999 11.9102H8.78999C9.00333 11.9102 9.17666 11.9569 9.30999 12.0502C9.44999 12.1436 9.54333 12.2736 9.58999 12.4402C9.63666 12.6002 9.63333 12.7802 9.57999 12.9802L8.63999 16.3902C8.61333 16.4902 8.62333 16.5702 8.66999 16.6302C8.71666 16.6836 8.77666 16.7069 8.84999 16.7002C8.92999 16.6936 8.99666 16.6602 9.04999 16.6002L15.89 8.50023Z";

/** Official Ultrafast double bolt, as shipped in the Desktop bundle at viewBox -1 -1 22 22. */
const ULTRAFAST_BOLT_PATH =
  "M12.496 1.55042C13.3266 0.810781 14.6664 1.57948 14.3945 2.70277L13.3867 6.86097H18.0634C19.0535 6.86124 19.5922 8.01841 18.955 8.77601L11.248 17.9284C11.0114 18.2091 10.5914 18.2449 10.3105 18.0084C10.0297 17.7718 9.99389 17.3518 10.2304 17.0709L17.7089 8.19105H15.206C15.199 8.46403 15.1069 8.74127 14.9043 8.98206L7.24312 18.0797C6.45061 19.0208 4.92981 18.25 5.21968 17.0543L6.1689 13.1383H1.7607C0.663874 13.1383 0.0668853 11.8562 0.773392 11.0172L8.43453 1.91956C9.22701 0.978906 10.7474 1.74955 10.458 2.94495L9.50874 6.86097H12.0175L12.956 2.98987L12.7773 3.17933C12.5246 3.44588 12.1034 3.45737 11.8369 3.20472C11.5706 2.95204 11.5599 2.53172 11.8125 2.26527L12.4169 1.62659L12.496 1.55042Z";

/**
 * The two tier icons in one place: the stylesheet masks them into the official
 * trigger and into the ParticleSlider's accents, so every codexhost surface
 * draws the same official geometry.
 */
export const CODEX_SERVICE_TIER_BOLT_PATHS = {
  fast: { viewBox: "0 0 20 20", d: FAST_BOLT_PATH },
  ultrafast: { viewBox: "-1 -1 22 22", d: ULTRAFAST_BOLT_PATH },
} as const;

export type CodexServiceTierBoltTier = keyof typeof CODEX_SERVICE_TIER_BOLT_PATHS;

/** One tier's icon as an SVG data URL, for the CSS masks below. */
function boltMaskUrl(tier: CodexServiceTierBoltTier): string {
  const { viewBox, d } = CODEX_SERVICE_TIER_BOLT_PATHS[tier];
  return encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><path d="${d}" fill="black"/></svg>`,
  );
}

/**
 * Particle drift distance in pixels. It appears in three coupled places per
 * layer — the keyframes start offset, `background-size` width, and the `left`
 * overhang — so the repeating tile loops seamlessly; keep them equal.
 */
const PARTICLE_DRIFT_PX = 150;

type ParticleDot = readonly [x: number, y: number, alpha: number, radius: number];

/**
 * Official TrackParticle: a 3px dot (background #ffffffb8) with a 5px glow
 * (box-shadow 0 0 5px #ffffff57). Each dot becomes one radial-gradient of a
 * 150px tile with its own alpha/scale, approximating the per-particle opacity
 * (0.4–1.0) and scale (0.5–0.95) the official 14 paths randomize.
 */
function particleDots(dots: readonly ParticleDot[]): string {
  return dots
    .map(([x, y, alpha, radius]) => {
      const glow = Math.round(alpha * 0.47 * 100) / 100;
      return (
        `radial-gradient(circle at ${x}px ${y}%, ` +
        `rgba(255, 255, 255, ${alpha}) 0 ${radius}px, ` +
        `rgba(255, 255, 255, ${glow}) ${radius}px ${radius + 1.3}px, ` +
        `rgba(255, 255, 255, 0) ${radius + 2.2}px)`
      );
    })
    .join(",\n      ");
}

/** Six dots for the denser Ultrafast field; tops stay inside the official 12%–88% band. */
const ULTRAFAST_DOTS: readonly ParticleDot[] = [
  [14, 34, 0.72, 1.5],
  [39, 76, 0.6, 1.4],
  [64, 20, 0.66, 1.45],
  [88, 58, 0.72, 1.5],
  [112, 30, 0.55, 1.3],
  [136, 74, 0.68, 1.45],
];

/** Six dots for Fast, matching the official per-track density more closely than Ultrafast. */
const FAST_DOTS: readonly ParticleDot[] = [
  [18, 22, 0.72, 1.5],
  [44, 66, 0.5, 1.25],
  [70, 36, 0.72, 1.5],
  [95, 80, 0.62, 1.4],
  [119, 26, 0.55, 1.3],
  [140, 60, 0.72, 1.5],
];

/** A fainter, slower second Ultrafast stream for depth; kept deliberately sparse. */
const ULTRAFAST_ECHO_DOTS: readonly ParticleDot[] = [
  [26, 52, 0.45, 1.15],
  [62, 18, 0.42, 1.1],
  [98, 82, 0.5, 1.2],
  [134, 44, 0.4, 1.1],
];

function trackScope(tier: CodexServiceTierId, pseudo: "::before" | "::after"): string {
  // `data-model-picker-power-slider` is the slider Container, `_Track_` the
  // hashed class fragment of the official 24px track (`_Track_xwb5v_212` in
  // impl-1c8b0a94e9ce.css) and `_Range_` the blue fill it holds
  // (`_Range_xwb5v_222`, overflow:hidden, positioned by React). Particles
  // paint on the fill so the official track clipping plus the fill's own
  // width/offset keep them inside the selected range — the same visible area
  // the official JS clip-path produces. `data-fast-mode` /
  // `data-reduced-motion` are Boolean attributes of the slider Root;
  // `data-fast-mode="false"` keeps the official FastTrackParticles
  // (z-index 4, `_FastParticleClip_`) the only particle layer when native
  // Fast is on, and `data-reduced-motion="false"` respects the Desktop app's
  // own motion setting in addition to the media query below. The scope
  // attribute is written only on the menu portal the local control owns, so
  // the particles cannot ride a remote Host's menu.
  return (
    `[${CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE}="${tier}"] ` +
    `[data-model-picker-power-slider] ` +
    `[data-fast-mode="false"][data-reduced-motion="false"] ` +
    `[class*="_Range_"]${pseudo}`
  );
}

export function codexServiceTierStyleText(): string {
  const particleLayers = [
    trackScope("fast", "::after"),
    trackScope("ultrafast", "::after"),
    trackScope("ultrafast", "::before"),
  ];
  return `
/* Codex request-tier accents (codexhost). Every rule below is scoped to
   [data-codexhost-service-tier-scope], written by the local tier control onto
   the local Composer root (trigger bolt) and the official menu portal it owns
   (slider particles); a remote Host or external Harness surface is never
   stamped and never painted. */

/* Both gates must hold: the Desktop's own motion setting (the
   data-reduced-motion attribute in the scope above, which is what the official
   slider itself binds its durations to) and the system preference. */@media (prefers-reduced-motion: no-preference) {
  ${particleLayers.join(",\n  ")} {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    /* One drift overhang so the repeating tile always covers the fill. */
    left: -${PARTICLE_DRIFT_PX}px;
    right: 0;
    z-index: 1;
    pointer-events: none;
    background-repeat: repeat;
    background-size: ${PARTICLE_DRIFT_PX}px 100%;
    animation: codexhost-service-tier-particle-drift 1.15s linear infinite;
    will-change: transform;
  }

  ${trackScope("fast", "::after")} {
    background-image: ${particleDots(FAST_DOTS)};
    animation-duration: 1.15s;
  }

  ${trackScope("ultrafast", "::after")} {
    background-image: ${particleDots(ULTRAFAST_DOTS)};
    animation-duration: 0.92s;
  }

  ${trackScope("ultrafast", "::before")} {
    background-image: ${particleDots(ULTRAFAST_ECHO_DOTS)};
    animation-duration: 1.4s;
    opacity: 0.85;
  }
}

@keyframes codexhost-service-tier-particle-drift {
  from {
    transform: translateX(${PARTICLE_DRIFT_PX}px);
  }
  to {
    transform: translateX(0);
  }
}

/* The tier gear inside the official Model trigger. Keyed on the scope
   attribute the local tier control writes onto the local Composer root, so it
   appears exactly while a tier is confirmed for that local Composer and leaves
   with the state — no DOM writes beyond the scope stamp, no JS.
   The Desktop renders the trigger's model name in one of two shapes, so both are
   covered and never both at once:
   - the labelled shape wraps the name in ModelPickerTriggerModelGroup, the
     inline-flex group that holds the official ModelPickerTriggerInlineModeIcon;
   - the compact shape puts it in the model label's own tabular-nums row, right
     after the optional Daybreak / reserve markers.
   Either way the pseudo-element is a flex child at 14px with the group's 4px gap,
   i.e. the slot the official icon occupies, so no text node and no React-managed
   child of the trigger is touched. An external Harness Composer hides the native
   trigger entirely, which hides the gear with it; a remote Host Composer is
   never stamped, so it cannot draw the gear.
   The Desktop shows the Daybreak sun in this slot instead of the speed gear
   whenever Daybreak applies (the sun icon or the speed bolt), so the
   pseudo-element is suppressed under the same marker instead of stacking a
   second icon. */
[${CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE}]
  :is(
    [data-codex-intelligence-trigger] [class*="ModelPickerTriggerModelGroup"],
    [data-codex-intelligence-trigger]
      [class~="tabular-nums"]:not([class*="ModelPickerTriggerModelGroup"] *)
  ):not(:has([data-daybreak-indicator]))::before {
  content: "";
  display: inline-block;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  background-color: currentcolor;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-position: center;
  mask-position: center;
  -webkit-mask-size: contain;
  mask-size: contain;
}
/* Standard draws the same official bolt at the same 14px geometry, but is a
   resting state: the glyph keeps the official tertiary (at-rest) color rather
   than the trigger's own text color, and no particle layer is keyed on it, so
   a Standard selection adds no accent beyond the resting glyph. */
[${CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE}="standard"]
  :is(
    [data-codex-intelligence-trigger] [class*="ModelPickerTriggerModelGroup"],
    [data-codex-intelligence-trigger]
      [class~="tabular-nums"]:not([class*="ModelPickerTriggerModelGroup"] *)
  ):not(:has([data-daybreak-indicator]))::before {
  background-color: var(--color-text-tertiary, #8f8f8f);
  -webkit-mask-image: url("data:image/svg+xml,${boltMaskUrl("fast")}");
  mask-image: url("data:image/svg+xml,${boltMaskUrl("fast")}");
}
[${CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE}="fast"]
  :is(
    [data-codex-intelligence-trigger] [class*="ModelPickerTriggerModelGroup"],
    [data-codex-intelligence-trigger]
      [class~="tabular-nums"]:not([class*="ModelPickerTriggerModelGroup"] *)
  ):not(:has([data-daybreak-indicator]))::before {
  -webkit-mask-image: url("data:image/svg+xml,${boltMaskUrl("fast")}");
  mask-image: url("data:image/svg+xml,${boltMaskUrl("fast")}");
}
[${CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE}="ultrafast"]
  :is(
    [data-codex-intelligence-trigger] [class*="ModelPickerTriggerModelGroup"],
    [data-codex-intelligence-trigger]
      [class~="tabular-nums"]:not([class*="ModelPickerTriggerModelGroup"] *)
  ):not(:has([data-daybreak-indicator]))::before {
  -webkit-mask-image: url("data:image/svg+xml,${boltMaskUrl("ultrafast")}");
  mask-image: url("data:image/svg+xml,${boltMaskUrl("ultrafast")}");
}

/* The codexhost speed button inside the official Model menu's _ViewControls_
   row and the 233px tier flyout it opens. Geometry mirrors the official
   _FastModeToggle_ (32px box at the row's inline start, 26px content square,
   16px icon) and the official 233px submenu surface. The enabled color is the
   official chart-blue; the official max-power purple is intentionally NOT
   reproduced (no reliable source for it here). */
/* The official row reserves the toggle's footprint with 16px inline padding
   whenever a toggle exists; the official [data-explicit-model=true] rule must
   still win, so it is restated afterwards at equal specificity. */
[class*="ViewControls"]:has([data-codexhost-service-tier-toggle]) {
  padding-inline: 16px;
}
[class*="ViewControls"][data-explicit-model="true"]:has([data-codexhost-service-tier-toggle]) {
  padding-inline: calc(var(--spacing, 4px) * 8);
}

[data-codexhost-service-tier-toggle] {
  position: absolute;
  inset-inline-start: 0;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  justify-content: center;
  width: 32px;
  min-height: 32px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 8px;
  flex-shrink: 0;
  /* Official color: tertiary at rest, the chart blue while a tier is active. */
  color: var(--color-text-tertiary, #8f8f8f);
  background: transparent;
  cursor: pointer;
  font: inherit;
  outline-offset: 2px;
  outline: 2px solid transparent;
}
/* The official explicit-model layout pins both side controls to the top. */
[class*="ViewControls"][data-explicit-model="true"] [data-codexhost-service-tier-toggle] {
  inset-block-start: 0;
}
[data-codexhost-service-tier-toggle][data-fast-mode-enabled="true"] {
  color: var(--color-chart-blue, #3b82f6);
}
[data-codexhost-service-tier-toggle]:focus-visible {
  outline-color: var(--color-token-border, rgba(127, 127, 127, 0.6));
}
/* The official hover: only the inner square highlights. */
[data-codexhost-service-tier-toggle]:hover [data-codexhost-service-tier-toggle-content],
[data-codexhost-service-tier-toggle]:focus-visible [data-codexhost-service-tier-toggle-content],
[data-codexhost-service-tier-toggle][aria-expanded="true"]
  [data-codexhost-service-tier-toggle-content] {
  background: var(--color-background-primary-ghost-hover, rgba(127, 127, 127, 0.09));
}
[data-codexhost-service-tier-toggle-content] {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  margin-inline: auto;
  border-radius: 7px;
}
[data-codexhost-service-tier-toggle-content] > svg {
  width: 16px;
  height: 16px;
}
/* The panel holding the button is swapped out (aria-hidden / inert / hidden)
   in the advanced model list; a control that stayed visible there would float
   outside the panel the user is looking at. The ultra-warning row replaces the
   controls entirely, exactly like the official _FastModeToggle_. */
[class*="ViewTrack"][aria-hidden="true"] [data-codexhost-service-tier-toggle],
[class*="ViewTrack"][inert] [data-codexhost-service-tier-toggle],
[class*="ViewTrack"][hidden] [data-codexhost-service-tier-toggle],
[class*="ViewControls"][data-ultra-warning-visible="true"]
  [data-codexhost-service-tier-toggle] {
  display: none;
}

/* The tier flyout: the official 233px submenu surface, rendered as a manual
   popover so the menu's overflow:clip body and its transforms cannot clip or
   displace it. The UA popover styles (inset:0, margin:auto, fit-content) are
   fully overridden; the open/close state itself remains the popover API's. */
[data-codexhost-service-tier-flyout] {
  position: fixed;
  inset: auto;
  margin: 0;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 233px;
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 16px);
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--color-border-subtle, rgba(127, 127, 127, 0.2));
  border-radius: 12px;
  background: var(--color-surface-elevated-secondary, Canvas);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
  color: var(--color-text, CanvasText);
  font-family: inherit;
  font-size: 14px;
  line-height: 20px;
}
[data-codexhost-service-tier-flyout]:not(:popover-open) {
  display: none;
}

[data-codexhost-service-tier-option] {
  /* Explicit resets: the option must not depend on a host stylesheet reset.
     border-box keeps the box exactly 233px wide minus the flyout padding. */
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 8px;
  font-family: inherit;
  font-size: 14px;
  line-height: 20px;
  color: var(--color-text, CanvasText);
  background: transparent;
  cursor: pointer;
  text-align: start;
}
[data-codexhost-service-tier-option]:hover,
[data-codexhost-service-tier-option]:focus-visible {
  background: var(--color-background-primary-ghost-hover, rgba(127, 127, 127, 0.09));
}
[data-codexhost-service-tier-option]:focus-visible {
  outline: 2px solid var(--color-token-border, rgba(127, 127, 127, 0.6));
  outline-offset: -2px;
}
[data-codexhost-service-tier-option][aria-checked="true"] {
  background: var(--color-token-list-hover-background, rgba(127, 127, 127, 0.07));
}
[data-codexhost-service-tier-option-text] {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
}
[data-codexhost-service-tier-option-label] {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-codexhost-service-tier-option-description] {
  color: var(--color-codex-description, var(--color-text-tertiary, #8f8f8f));
  font-size: 13px;
  line-height: 18px;
}
/* The official selected-row check renders at its resource's own 17px canvas. */
[data-codexhost-service-tier-option-check] {
  display: inline-flex;
  width: 17px;
  height: 17px;
  flex: none;
  color: var(--color-text-secondary, CanvasText);
}
[data-codexhost-service-tier-option-check] > svg {
  width: 100%;
  height: 100%;
}
[data-codexhost-service-tier-option-check][data-checked="false"] {
  visibility: hidden;
}

/* Keep the focus ring visible in forced colors; nothing else marks the focus.
   Placed after every focus rule above so it wins at equal specificity: the
   option's own outline shorthand would otherwise reset this color, and the
   toggle's token color would otherwise stand. */
@media (forced-colors: active) {
  [data-codexhost-service-tier-toggle]:focus-visible,
  [data-codexhost-service-tier-option]:focus-visible {
    outline-color: CanvasText;
  }
}
`;
}

/**
 * Inject the service-tier stylesheet once per document and return its disposer.
 * Idempotent: a second live install reuses the existing style element instead
 * of stacking duplicates. Partial Document mocks (tests that only need event
 * listeners) are tolerated by skipping installation.
 */
export function installCodexServiceTierStyle(ownerDocument: Document): () => void {
  if (
    typeof ownerDocument?.querySelector !== "function" ||
    typeof ownerDocument.createElement !== "function"
  ) {
    return () => {};
  }
  if (ownerDocument.querySelector(`style[${CODEX_SERVICE_TIER_STYLE_ATTRIBUTE}]`)) {
    return () => {};
  }
  const host = ownerDocument.head ?? ownerDocument.documentElement;
  if (!host || typeof host.append !== "function") return () => {};
  const style = ownerDocument.createElement("style");
  style.setAttribute(CODEX_SERVICE_TIER_STYLE_ATTRIBUTE, "true");
  style.textContent = codexServiceTierStyleText();
  host.append(style);
  return () => style.remove();
}

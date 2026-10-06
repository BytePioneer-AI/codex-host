import { build } from "esbuild";
import path from "node:path";
import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

/**
 * Settings + Composer fixture for the Codex request-tier feature.
 *
 * The page reproduces the real conditions the production control runs under,
 * taken from the unpacked Desktop 26.928 assets:
 *
 * 1. The official simple Model menu: the 254px `_ModelPickerDropdownContent_`
 *    (`will-change: opacity, transform` — a containing block and stacking
 *    context, exactly the condition the official submenu escapes by rendering
 *    into its own overlay layer), carrying `overflow-x-hidden overflow-y-hidden`
 *    Tailwind utilities, wrapping `_ViewTrack_` (`overflow: clip`) with the
 *    `_SliderTopRowMotion_` top row and its `_ViewControls_` row
 *    (min-height 36px, flex, centered, `position: relative`, official
 *    `padding-inline` rules) where the official model view toggle lives, with
 *    the optional `_ResetToDefault_` button and `_UltraUsageWarning_` beside
 *    it. The official rules are copied verbatim from the deployed stylesheet.
 *    A reasoning-power slider (`data-model-picker-power-slider` with the
 *    official `_Track_` / `_Range_` fragments and `data-fast-mode` /
 *    `data-reduced-motion` roots) carries the CSS-only particle accent.
 * 2. The official parent Menu behavior: a capture-phase keydown that walks
 *    `[role^="menuitem"]:not([data-disabled]):not([data-interactive="false"])`,
 *    drops results hidden under `[inert], [hidden], [aria-hidden="true"]`
 *    (`Q0e`), and, only when the current target is in the filtered list,
 *    preventDefaults and moves focus (Tab / ArrowDown / ArrowUp, wrapping,
 *    shift-Tab backwards). The algorithm is reproduced verbatim from the
 *    deployed bundle, never approximated.
 * 3. `#zoom-host` can put the menu (and with it the top-layer flyout it owns)
 *    under a real CSS `zoom: 1.25`, the condition the official submenu handles.
 *
 * Two Composers exist side by side, each with its own native trigger and its
 * own menu portal, and each is routed through the production pieces:
 *
 * - `rendererServiceTierPlacement` decides per Composer from that Composer's
 *   own Host id, its Agent and its switching flag plus the Host-confirmed
 *   `<html data-codexhost-service-tier>` state contract;
 * - `mountRendererServiceTierControl` is the production control, and it stamps
 *   its ownership scope (`data-codexhost-service-tier-scope`) onto the local
 *   Composer root and the menu portal it owns — the CSS keys on that stamp
 *   only, so nothing here sets a scope by hand.
 *
 * `#global-route` is deliberately decoupled from both Composers: the spec uses
 * it to hold the Host-wide route opposite to the local Composer and prove the
 * per-Composer routing does not follow it.
 */
export async function serviceTierFixtureHtml(): Promise<string> {
  const { outputFiles } = await build({
    stdin: {
      contents: `
        import { CODEX_SERVICE_TIER_SETTINGS_METHOD } from "./packages/shared-contracts/src/codex-service-tier.ts";
        import { createRendererModelClient } from "./packages/renderer-extension/src/renderer-model-client.ts";
        import { createRendererSettingsPageRegistry } from "./packages/renderer-extension/src/settings/core.ts";
        import { rendererSettingsMessages } from "./packages/renderer-extension/src/settings/localization.ts";
        import { mountRendererSettingsShell } from "./packages/renderer-extension/src/settings/shell.ts";
        import { mountCodexServiceTierControls } from "./packages/renderer-extension/src/settings/codex-service-tier-controls.ts";
        import {
          installCodexServiceTierPreferenceSync,
          readCodexServiceTierPreference,
        } from "./packages/renderer-extension/src/renderer-codex-service-tier-preference.ts";
        import { installCodexServiceTierStyle, CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE } from "./packages/renderer-extension/src/renderer-codex-service-tier-style.ts";
        import {
          CODEX_SERVICE_TIER_FLYOUT_ATTRIBUTE,
          CODEX_SERVICE_TIER_OPTION_ATTRIBUTE,
          CODEX_SERVICE_TIER_TOGGLE_ATTRIBUTE,
          mountRendererServiceTierControl,
          rendererServiceTierPlacement,
        } from "./packages/renderer-extension/src/renderer-codex-service-tier-bolt.ts";

        const query = (selector) => {
          const element = document.querySelector(selector);
          if (!element) throw new Error("Fixture element missing: " + selector);
          return element;
        };
        const locale = new URL(location.href).searchParams.get("lang") === "en" ? "en" : "zh-CN";
        const messages = rendererSettingsMessages(locale);
        const output = query("output");
        const effectSelect = query("#effect");
        const zoomHost = query("#zoom-host");
        const tierSelections = [];
        let pending = null;

        // The Host contract: the confirmed effect decides the marker, and each
        // Composer speed control mirrors only that confirmed effect.
        const effectFor = (settings) => {
          if (!settings.enabled) return { state: "off" };
          const choice = effectSelect.value;
          if (choice === "officialProvider") return { state: "inactive", reason: "officialProvider" };
          if (choice === "notAdvertised") return { state: "active", notice: "notAdvertised" };
          return { state: "active" };
        };
        const client = createRendererModelClient([{ sendRequest(method, params) {
          if (method !== CODEX_SERVICE_TIER_SETTINGS_METHOD) throw new Error("Unexpected Host method: " + method);
          output.textContent = JSON.stringify(params);
          return new Promise((resolve, reject) => { pending = { settings: params, resolve, reject }; });
        } }]);
        const sync = installCodexServiceTierPreferenceSync(window);
        const registry = createRendererSettingsPageRegistry([{
          id: "appearance", label: messages.pageLabels.appearance, icon: "settings",
          mount: context => mountCodexServiceTierControls(context, messages),
        }]);
        const shell = mountRendererSettingsShell(registry, document, messages);
        const style = installCodexServiceTierStyle(document);

        // ---- Fixture recorders -------------------------------------------------
        // A real MutationObserver over the menu host: the "no DOM writes" guard
        // is asserted against records, not against a stubbed element.
        const records = [];
        const menuObserver = new MutationObserver((list) => { for (const record of list) records.push(record); });
        const observeMenuHost = (node) => menuObserver.observe(node, {
          attributes: true, childList: true, subtree: true, characterData: true,
        });
        const keyLog = [];
        window.addEventListener("keydown", (event) => keyLog.push({ key: event.key, event }), true);
        // Real pointer/focus traffic, so a spec can prove a close came from the
        // mutation observer rather than from an outside press or focus move.
        const pointerLog = [];
        const focusLog = [];
        window.addEventListener("pointerdown", (event) => pointerLog.push(event.target), true);
        window.addEventListener("focusin", (event) => focusLog.push(event.target), true);
        const stale = { handles: [] };
        globalThis.tierSelections = tierSelections;
        globalThis.storedTier = null;

        // ---- The official menu -------------------------------------------------
        let menuSerial = 0;
        const menuHtml = (id) => \`
          <div class="_ModelPickerDropdownContent_1ndnu_2 overflow-x-hidden overflow-y-hidden" data-state="open">
            <div class="fixture-menu-header">Search and sections above the view controls</div>
            <div class="_ViewTrack_1d00n_65" data-active="true" id="\${id}-simple">
              <div class="_SliderTopRowMotion_1d00n_8" data-active="true">
                <div class="_ViewControls_1d00n_170" data-ultra-warning-visible="false">
                  <button type="button" role="menuitem" class="_ViewToggle_1d00n_195" data-interactive="true"
                    data-model-picker-view-toggle="true" aria-label="Model view">Model</button>
                  <button type="button" class="_ResetToDefault_1d00n_224" data-interactive="false" aria-label="Reset to default">
                    <span class="_ResetToDefaultContent_1d00n_364">R</span>
                  </button>
                  <div class="_UltraUsageWarning_1d00n_55">Ultra warning</div>
                </div>
              </div>
            </div>
            <div class="_ViewTrack_1d00n_65" data-active="false" id="\${id}-advanced" style="display:none">
              <button type="button" role="menuitem" data-interactive="true" id="\${id}-advanced-row">Advanced model</button>
            </div>
            <div data-model-picker-power-slider="true">
              <div class="fixture-slider-root" data-fast-mode="false" data-reduced-motion="false">
                <div class="_Track_xwb5v_212"><div class="_Range_xwb5v_222"></div></div>
              </div>
            </div>
            <button type="button" role="menuitem" data-interactive="true" id="\${id}-plain-row">Plain official row</button>
          </div>\`;
        const buildMenu = (id) => {
          const menu = document.createElement("div");
          menu.setAttribute("role", "menu");
          menu.setAttribute("aria-label", "Model and Thinking");
          menu.setAttribute("id", id);
          menu.setAttribute("class", "fixture-model-menu");
          menu.setAttribute("data-open", "false");
          menu.innerHTML = menuHtml(id);
          return menu;
        };

        // ---- The two Composers -------------------------------------------------
        // Each carries the local or the remote Host id; nothing reads the
        // global route for placement, exactly like the production probe.
        const contexts = {
          local: {
            hostId: "local", agent: "codex", switching: false,
            root: query("#local-composer"), trigger: query("#native-trigger"),
            menuHost: query("#local-menu-host"), menuId: null,
          },
          remote: {
            hostId: "remote-ssh:linux", agent: "codex", switching: false,
            root: query("#remote-composer"), trigger: query("#remote-trigger"),
            menuHost: query("#remote-menu-host"), menuId: null,
          },
        };
        let globalRoute = "remote-ssh:linux";
        const controls = {
          local: mountRendererServiceTierControl(),
          remote: mountRendererServiceTierControl(),
        };
        const lastPlacements = {};

        const officialWalk = (event, menu) => {
          const target = event.target;
          if (!(target instanceof HTMLElement)) return;
          if (event.key === "Enter" || event.key === " ") {
            // The official menu records the acknowledged row for its refocus
            // effect; the rows that opt out with data-interactive="false" are
            // still matched here, exactly like the deployed bundle.
            return;
          }
          if (event.key !== "Tab" && event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          if (target.closest('[role="slider"]') != null) return;
          if (!menu.contains(target)) return;
          const items = Array.from(menu.querySelectorAll('[role^="menuitem"]:not([data-disabled]):not([data-interactive="false"])'))
            .filter((item) => item.closest('[inert], [hidden], [aria-hidden="true"]') == null);
          const index = items.findIndex((item) => item === target || item.contains(target));
          if (index === -1 || items.length === 0) return;
          const next = (index + (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey) ? -1 : 1) + items.length) % items.length;
          event.preventDefault();
          event.stopPropagation();
          items[next]?.focus();
        };
        const installMenuBehaviors = (menu, context) => {
          menu.addEventListener("keydown", (event) => officialWalk(event, menu), true);
          menu.addEventListener("click", (event) => {
            const target = event.target;
            if (target instanceof Element && target.closest("button[role=\\"menuitem\\"]:not([data-codexhost-service-tier-toggle])")) {
              closeContextMenu(context);
            }
          });
        };
        const menuFor = (context) => (context.menuId ? document.getElementById(context.menuId) : null);
        const buildContextMenu = (context, open) => {
          const previous = menuFor(context);
          if (previous) previous.remove();
          const id = "fixture-model-menu-" + (++menuSerial);
          const menu = buildMenu(id);
          menu.setAttribute("data-open", String(open));
          context.menuId = id;
          context.menuHost.append(menu);
          installMenuBehaviors(menu, context);
          // The trigger always points at the live menu, exactly like the
          // Desktop popover after a rebuild.
          if (open) context.trigger.setAttribute("aria-controls", id);
          else context.trigger.removeAttribute("aria-controls");
          return menu;
        };
        const openContextMenu = (context) => {
          const menu = menuFor(context);
          if (!menu) return;
          menu.setAttribute("data-open", "true");
          context.trigger.setAttribute("aria-controls", menu.id);
          renderServiceTier();
        };
        const closeContextMenu = (context) => {
          const menu = menuFor(context);
          menu?.removeAttribute("data-open");
          context.trigger.removeAttribute("aria-controls");
          renderServiceTier();
        };
        const rebuildContextMenu = (context) => {
          const old = menuFor(context);
          if (!old) return;
          // Only the local rebuild is recorded: the specs drive its stale
          // handles. Both menus rebuild identically.
          if (context === contexts.local) {
            stale.handles.push({
              menu: old,
              toggle: old.querySelector("[" + ${JSON.stringify("data-codexhost-service-tier-toggle")} + "]"),
              flyout: old.querySelector("[" + ${JSON.stringify("data-codexhost-service-tier-flyout")} + "]"),
              options: Array.from(old.querySelectorAll("[" + ${JSON.stringify("data-codexhost-service-tier-option")} + "]")),
            });
          }
          const open = old.getAttribute("data-open") === "true";
          buildContextMenu(context, open);
          renderServiceTier();
        };
        for (const context of Object.values(contexts)) {
          buildContextMenu(context, false);
        }
        observeMenuHost(contexts.local.menuHost);

        // The Desktop closes the popover on any outside press; the fixture does
        // the same so a real outside click exercises the control's own close.
        // The Test Host console is exempt: its buttons stand in for the app's
        // own state changes (panel swap, warning, zoom), which in the Desktop
        // arrive as re-renders, not as outside presses.
        document.addEventListener("pointerdown", (event) => {
          const target = event.target;
          if (!(target instanceof Element)) return;
          if (target.closest("aside[aria-label='Test Host']")) return;
          for (const context of Object.values(contexts)) {
            const menu = menuFor(context);
            if (!menu || menu.getAttribute("data-open") !== "true") continue;
            if (target.closest("#" + CSS.escape(menu.id)) || target.closest("#" + CSS.escape(context.trigger.id))) continue;
            closeContextMenu(context);
          }
        }, true);
        for (const context of Object.values(contexts)) {
          context.trigger.addEventListener("click", () => {
            if (menuFor(context)?.getAttribute("data-open") === "true") closeContextMenu(context);
            else openContextMenu(context);
          });
        }

        // ---- The tier controls -------------------------------------------------
        // The production probe writes the preference from the picked option:
        // every value is a real tier, Standard included, and a pick never
        // turns the feature off (only the settings switch does).
        const onSelect = (tier) => {
          const owner = document.defaultView;
          const current = readCodexServiceTierPreference(owner);
          const next = { ...current, enabled: true, tier };
          localStorage.setItem("codexhost.codex-service-tier.v1", JSON.stringify(next));
          window.dispatchEvent(new Event("codexhost:codex-service-tier-changed"));
          tierSelections.push(tier);
          globalThis.storedTier = readCodexServiceTierPreference(owner).tier;
        };
        // Each Composer routes through the production placement: its own Host
        // id, its Agent, its switching flag and the confirmed <html> state.
        const renderContext = (name) => {
          const context = contexts[name];
          const value = document.documentElement.getAttribute(${JSON.stringify("data-codexhost-service-tier")});
          const confirmedTier =
            value === "standard" || value === "fast" || value === "ultrafast" ? value : null;
          const placement = rendererServiceTierPlacement({
            agent: context.agent,
            hostId: context.hostId,
            switching: context.switching,
            confirmedTier,
          });
          lastPlacements[name] = { ...placement, globalRoute };
          controls[name].render({
            tier: placement.tier,
            suppressed: placement.suppressed,
            scope: placement.tier === null ? null : context.root,
            trigger: context.trigger,
            locale,
            onSelect,
          });
        };
        const renderServiceTier = () => {
          renderContext("local");
          renderContext("remote");
        };
        const tierObserver = new MutationObserver(renderServiceTier);
        tierObserver.observe(document.documentElement, { attributes: true, attributeFilter: [${JSON.stringify("data-codexhost-service-tier")}] });
        renderServiceTier();

        // ---- Fixture controls --------------------------------------------------
        query("#open-menu").onclick = () => openContextMenu(contexts.local);
        query("#close-menu").onclick = () => closeContextMenu(contexts.local);
        query("#rebuild-menu").onclick = () => rebuildContextMenu(contexts.local);
        query("#remote-open-menu").onclick = () => openContextMenu(contexts.remote);
        query("#remote-close-menu").onclick = () => closeContextMenu(contexts.remote);
        query("#remote-rebuild-menu").onclick = () => rebuildContextMenu(contexts.remote);
        query("#zoom-toggle").onclick = () => {
          zoomHost.style.zoom = zoomHost.style.zoom === "1.25" ? "" : "1.25";
        };
        // Moving the local menu host to the right viewport edge reproduces the
        // measured report: a side panel occupies the right rail, so the real
        // menu (and its popover) is pushed against the right edge.
        query("#menu-right-edge").onclick = () => {
          const host = contexts.local.menuHost;
          host.style.left = "auto";
          host.style.right = "8px";
        };
        query("#local-agent").onchange = (event) => {
          contexts.local.agent = event.target.value;
          renderServiceTier();
        };
        query("#local-host").onchange = (event) => {
          contexts.local.hostId = event.target.value;
          renderServiceTier();
        };
        query("#remote-host").onchange = (event) => {
          contexts.remote.hostId = event.target.value;
          renderServiceTier();
        };
        query("#global-route").onchange = (event) => {
          globalRoute = event.target.value;
          renderServiceTier();
        };
        query("#local-switching").onclick = () => {
          contexts.local.switching = !contexts.local.switching;
          renderServiceTier();
        };
        // Panel-state controls a spec can drive without any pointer or focus
        // event, standing in for the Desktop re-rendering under the open popover.
        const setView = (advanced) => {
          const menu = menuFor(contexts.local);
          const simple = menu?.querySelector('[class*="ViewTrack"][data-active="true"]');
          const advancedTrack = menu?.querySelector('[class*="ViewTrack"][data-active="false"]');
          if (!simple || !advancedTrack) return;
          if (advanced) {
            simple.setAttribute("aria-hidden", "true");
            simple.setAttribute("inert", "");
            advancedTrack.style.display = "";
          } else {
            simple.removeAttribute("aria-hidden");
            simple.removeAttribute("inert");
            advancedTrack.style.display = "none";
          }
        };
        const setUltraWarning = (visible) => {
          const controls_ = menuFor(contexts.local)?.querySelector('[class*="ViewControls"]');
          controls_?.setAttribute("data-ultra-warning-visible", String(visible));
        };
        query("#switch-view").onclick = () => {
          const simple = menuFor(contexts.local)?.querySelector('[class*="ViewTrack"][data-active="true"]');
          setView(simple?.getAttribute("aria-hidden") !== "true");
        };
        query("#ultra-warning").onclick = () => {
          const controls_ = menuFor(contexts.local)?.querySelector('[class*="ViewControls"]');
          setUltraWarning(controls_?.getAttribute("data-ultra-warning-visible") !== "true");
        };
        // The official menu can flip a visibility attribute on its own rows for
        // one frame while the pointer crosses them; this stands in for that
        // traffic so the spec can prove the grace keeps the flyout open. The
        // restore lands on the first frame, always inside the two-frame grace,
        // whatever the display's refresh rate turns out to be. Driven through
        // the fixture hook rather than a button click: an outside pointer press
        // is itself a dismissal and cannot carry this case.
        const transientFlip = () => {
          const simple = menuFor(contexts.local)?.querySelector('[class*="ViewTrack"][data-active="true"]');
          if (!simple) return;
          simple.setAttribute("aria-hidden", "true");
          requestAnimationFrame(() => simple.removeAttribute("aria-hidden"));
        };
        query("#dispose-tier").onclick = () => {
          controls.local.dispose();
          controls.remote.dispose();
        };
        query("#remount-tier").onclick = () => {
          controls.local = mountRendererServiceTierControl();
          controls.remote = mountRendererServiceTierControl();
          renderServiceTier();
        };
        query("#accept").onclick = () => {
          if (pending) {
            const current = pending; pending = null;
            current.resolve({ settings: current.settings, effect: effectFor(current.settings) });
          }
        };
        query("#reject").onclick = () => {
          if (pending) { const current = pending; pending = null; current.reject(new Error("Test Host failure")); }
        };
        query("#reconnect").onclick = () => { sync.connect(null); sync.connect(client); };
        query("#remount").onclick = () => { shell.close(); shell.openSettings(undefined, "appearance"); };
        query("#dispose").onclick = () => {
          shell.dispose(); sync.dispose();
          controls.local.dispose(); controls.remote.dispose();
          style(); tierObserver.disconnect();
        };

        // ---- Spec hooks --------------------------------------------------------
        globalThis.__fixture = {
          scopeAttribute: CODEX_SERVICE_TIER_SCOPE_ATTRIBUTE,
          records,
          keyLog,
          pointerLog,
          focusLog,
          stale,
          tierSelections,
          contexts: {
            local: { rootId: "local-composer", menuHostId: "local-menu-host", triggerId: "native-trigger" },
            remote: { rootId: "remote-composer", menuHostId: "remote-menu-host", triggerId: "remote-trigger" },
          },
          lastPlacements,
          openMenu: () => openContextMenu(contexts.local),
          closeMenu: () => closeContextMenu(contexts.local),
          rebuildMenu: () => rebuildContextMenu(contexts.local),
          openRemoteMenu: () => openContextMenu(contexts.remote),
          closeRemoteMenu: () => closeContextMenu(contexts.remote),
          render: renderServiceTier,
          currentMenu: () => menuFor(contexts.local),
          remoteMenu: () => menuFor(contexts.remote),
          setView,
          setUltraWarning,
          transientFlip,
          settle: () => new Promise((resolve) => setTimeout(() => resolve(records.length), 0)),
          recordCount: () => records.length,
          clearRecords: () => { records.length = 0; },
          clearPointerLog: () => { pointerLog.length = 0; },
          clearFocusLog: () => { focusLog.length = 0; },
          keyLogSummary: () => keyLog.map(({ key, event }) => ({ key, defaultPrevented: event.defaultPrevented, canceled: event.cancelBubble })),
          currentRow: () => document.activeElement,
        };
        shell.openSettings(undefined, "appearance");
        sync.connect(client);
      `,
      resolveDir: path.resolve(import.meta.dirname, "../.."),
      sourcefile: "service-tier-fixture.ts",
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2024",
    loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
    plugins: [tailwindEsbuildPlugin()],
    write: false,
  });
  const script = outputFiles[0]?.text;
  if (!script) throw new Error("Missing service-tier fixture bundle");
  return `<!doctype html><html data-codex-window-type="browser"><head><meta charset="utf-8"><title>Codex request tier verification</title><style>
    /* The official fragments, copied verbatim from the unpacked Desktop
       26.928 stylesheet (app-primary-547a6c7b4fb3.css). They establish the
       real geometry, clipping and containing-block conditions. */
    :root { --spacing: 4px; --color-chart-blue: #3b82f6; --color-chart-purple: #a855f7; }
    .overflow-x-hidden { overflow-x: hidden; }
    .overflow-y-hidden { overflow-y: hidden; }
    ._ModelPickerDropdownContent_1ndnu_2 { --app-menu-gutter: 0px; width: calc(var(--spacing) * 63.5); transform-origin: var(--radix-dropdown-menu-content-transform-origin); will-change: opacity, transform; }
    ._ViewTrack_1d00n_65 { width: 100%; height: 100%; position: relative; overflow: clip; }
    ._ViewTrack_1d00n_65:last-child { position: absolute; inset-block-start: 0; inset-inline: 0; }
    ._ViewControls_1d00n_170 { justify-content: center; align-items: center; min-height: 36px; padding-inline: 8px; display: flex; position: relative; }
    ._ViewControls_1d00n_170:before { width: calc(var(--spacing) * 4); content: ""; flex-shrink: 0; }
    ._ViewControls_1d00n_170:has(._FastModeToggle_1d00n_54) { padding-inline: 16px; }
    ._ViewControls_1d00n_170[data-explicit-model=true] { padding-inline: calc(var(--spacing) * 8); }
    ._ViewControls_1d00n_170[data-explicit-model=true]:before { display: none; }
    ._ViewControls_1d00n_170[data-explicit-model=true] ._FastModeToggle_1d00n_54, ._ViewControls_1d00n_170[data-explicit-model=true] ._ResetToDefault_1d00n_224 { inset-block-start: 0; }
    ._ViewControls_1d00n_170[data-ultra-warning-visible=true] ._ViewToggle_1d00n_195, ._ViewControls_1d00n_170[data-ultra-warning-visible=true] ._FastModeToggle_1d00n_54, ._ViewControls_1d00n_170[data-ultra-warning-visible=true] ._ResetToDefault_1d00n_224 { visibility: hidden; pointer-events: none; }
    ._ViewControls_1d00n_170[data-ultra-warning-visible=true] ._UltraUsageWarning_1d00n_55 { opacity: 1; }
    ._ViewToggle_1d00n_195, ._FastModeToggle_1d00n_54, ._ResetToDefault_1d00n_224 { font-size: 14px; line-height: 20px; outline-style: none; }
    ._FastModeToggle_1d00n_54, ._ResetToDefault_1d00n_224 { width: 32px; min-height: 32px; color: var(--color-text-tertiary, #8f8f8f); border-radius: 8px; flex-direction: column; flex-shrink: 0; justify-content: center; margin: 0; padding: 0; display: flex; position: absolute; inset-inline-start: 0; }
    ._ResetToDefault_1d00n_224 { inset-inline: auto 0; }
    ._FastModeToggleContent_1d00n_362, ._ResetToDefaultContent_1d00n_364 { border-radius: 7px; justify-content: center; align-items: center; width: 26px; height: 26px; margin-inline: auto; display: flex; }
    ._UltraUsageWarning_1d00n_55 { color: var(--color-chart-purple); font-size: 14px; line-height: 20px; opacity: 0; pointer-events: none; white-space: nowrap; justify-content: center; align-items: center; display: flex; position: absolute; inset: 0; }
    /* The official reasoning-power slider fragments the particle rule rides. */
    .fixture-slider-root { position: relative; }
    ._Track_xwb5v_212 { position: relative; height: 24px; width: 180px; margin: 8px; background: #e5e5e5; border-radius: 6px; }
    ._Range_xwb5v_222 { position: absolute; top: 0; bottom: 0; left: 0; width: 110px; background: #3b82f6; border-radius: 6px; overflow: hidden; }
    /* End of the verbatim official fragments. */
    body { margin: 0; height: 100vh; font: 14px system-ui; color: #222; background: #fff; }
    /* The native rail the settings surface is placed beside (it reads the
       rail's real bounds and puts itself at rail.right). */
    nav[data-app-navigation-rail] { width: 64px; height: calc(100vh - 90px); padding-top: 10px; display: block; }
    nav[data-app-navigation-rail] button { width: 48px; margin: 8px; }
    /* The settings shell is a full-screen surface; the Composer surfaces under
       test stay above it. Both Composers exist at once, each with its own
       trigger, exactly like one local and one remote Host side by side. */
    [data-composer-footer] { position: fixed; z-index: 100000; bottom: 96px; left: 0; display: flex; gap: 24px; padding: 8px 20px; background: #fff; }
    [data-codex-composer-root] { display: inline-flex; align-items: center; }
    #local-menu-host { position: fixed; z-index: 100001; left: 30%; bottom: 140px; }
    #remote-menu-host { position: fixed; z-index: 100002; right: 8%; bottom: 140px; }
    /* A stable fixture class, not an id: the Desktop rebuilds the popover and
       the rebuilt menu must keep the same open/closed styling. */
    .fixture-model-menu { display: none; width: 254px; padding: 4px; border: 1px solid #ddd; border-radius: 12px; background: #fff; }
    .fixture-model-menu[data-open="true"] { display: block; }
    /* Real menus carry content above the view controls, so the trigger row is
       not at the menu's top edge; this stands in for that layout. */
    .fixture-menu-header { height: 96px; display: flex; align-items: center; color: #666; }
    [class*="ViewTrack"][data-active="false"] { height: auto; }
    .fixture-trigger { display: inline-flex; align-items: center; gap: 4px; height: 28px; border: 0; background: transparent; }
    .fixture-trigger > span, .fixture-trigger [class~="tabular-nums"] { display: inline-flex; align-items: center; gap: 4px; }
    aside { position: fixed; z-index: 99999; bottom: 0; left: 0; right: 0; height: 72px; background: #eee; padding: 8px 20px; }
    aside button, aside select { margin-right: 8px; } output { display: block; margin-top: 8px; }
  </style></head><body><nav data-app-navigation-rail="true"><button data-sidebar-destination="builtin:home" aria-current="page">Home</button></nav><main></main><div data-composer-footer><div id="local-composer" data-codex-composer-root="true"><button id="native-trigger" class="fixture-trigger" type="button" aria-haspopup="menu" data-codex-intelligence-trigger="true" data-composer-navigation-target="reasoning"><span class="flex max-w-40 min-w-0 items-center gap-1.5"><span class="flex min-w-0 items-center gap-1 tabular-nums"><span>6 Astra</span></span></span></button></div><div id="remote-composer" data-codex-composer-root="true"><button id="remote-trigger" class="fixture-trigger" type="button" aria-haspopup="menu" data-codex-intelligence-trigger="true" data-composer-navigation-target="reasoning"><span class="flex max-w-40 min-w-0 items-center gap-1.5"><span class="flex min-w-0 items-center gap-1 tabular-nums"><span>6 Astra</span></span></span></button></div></div><div id="zoom-host"><div id="local-menu-host"></div></div><div id="remote-menu-host"></div><aside aria-label="Test Host">
  <button id="accept">Confirm pending save</button><button id="reject">Reject pending save</button><button id="reconnect">Reconnect Host</button><button id="remount">Reopen settings</button><button id="dispose">Dispose settings</button><button id="open-menu">Open model menu</button><button id="close-menu">Close model menu</button><button id="rebuild-menu">Rebuild model menu</button><button id="remote-open-menu">Open remote model menu</button><button id="remote-close-menu">Close remote model menu</button><button id="remote-rebuild-menu">Rebuild remote model menu</button><button id="zoom-toggle">Toggle zoom</button><button id="menu-right-edge">Move menu to right edge</button><button id="ultra-warning">Toggle ultra warning</button><button id="switch-view">Switch view</button><button id="local-switching">Toggle local switching</button><button id="dispose-tier">Dispose tier control</button><button id="remount-tier">Remount tier control</button><label for="effect">Host effect</label><select id="effect"><option value="active" selected>active</option><option value="off">off</option><option value="officialProvider">inactive:officialProvider</option><option value="notAdvertised">active:notAdvertised</option></select><label for="local-agent">Local agent</label><select id="local-agent"><option value="codex" selected>codex</option><option value="claude-code">claude-code</option></select><label for="local-host">Local Composer host</label><select id="local-host"><option value="local" selected>local</option><option value="remote-ssh:linux">remote-ssh:linux</option></select><label for="remote-host">Remote Composer host</label><select id="remote-host"><option value="remote-ssh:linux" selected>remote-ssh:linux</option><option value="local">local</option></select><label for="global-route">Global route</label><select id="global-route"><option value="remote-ssh:linux" selected>remote-ssh:linux</option><option value="local">local</option></select><output aria-label="Pending Host settings"></output>
  </aside><script>${script.replaceAll("</script", "<\\/script")}</script></body></html>`;
}

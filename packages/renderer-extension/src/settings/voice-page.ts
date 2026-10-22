import {
  voiceSettingsStateSchema,
  type VoiceSettings,
  type VoiceSettingsRequest,
  type VoiceSettingsState,
} from "@codexhost/shared-contracts";
import { desktopVoiceCallActive } from "../voice-settings-sync.js";
import { h, button } from "../console/dom.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import {
  createPreferenceGroup,
  createPreferenceItem,
  createPreferenceSwitch,
  preferenceId,
} from "./preference-ui.js";
import { voiceMessages } from "./voice-messages.js";

export type VoiceSettingsRequestClient = (input: VoiceSettingsRequest) => Promise<unknown>;

/** Both settings surfaces edit the same snapshot with explicit apply semantics. */
export function createVoiceSettingsPage(
  locale: string,
  request: VoiceSettingsRequestClient,
  options: { id?: string; desktop?: boolean } = {},
): RendererSettingsPageDefinition {
  const m = voiceMessages(locale);
  return Object.freeze({
    id: options.id ?? "voice",
    label: m.title,
    icon: "settings",
    mount(context: RendererSettingsPageMountContext) {
      const doc = context.content.ownerDocument;
      let state: VoiceSettingsState | null = null;
      let base: VoiceSettingsState | null = null;
      let draft: VoiceSettings | null = null;
      let offline = false;
      let busy = false;
      let refreshing = false;
      let generation = 0;
      let disposed = false;
      let confirm = false;
      let advanced = false;
      let setup = false;
      let error: string | null = null;
      const ids = new Map<string, string>();
      const controlId = (key: string) => {
        const existing = ids.get(key);
        if (existing) return existing;
        const id = preferenceId(key);
        ids.set(key, id);
        return id;
      };
      const dirty = () => !!draft && JSON.stringify(draft) !== JSON.stringify(base?.settings);
      const isActiveCall = () =>
        state?.activeCall === true ||
        (options.desktop && !!doc.defaultView && desktopVoiceCallActive(doc.defaultView));
      const needsRestart = () =>
        !!draft &&
        !!state &&
        (state.activeInject === null
          ? draft.inject !== base?.settings.inject
          : (state.envOverride ? state.envOverride === "1" : draft.inject) !== state.activeInject);
      const load = async (reset = false) => {
        if (refreshing || busy || disposed) return;
        refreshing = true;
        const currentGeneration = generation;
        try {
          const next = voiceSettingsStateSchema.parse(await request({ operation: "get" }));
          if (disposed || generation !== currentGeneration) return;
          const changed = JSON.stringify(state) !== JSON.stringify(next) || offline || reset;
          if (reset || !dirty()) {
            base = next;
            draft = { ...next.settings };
          }
          state = next;
          offline = false;
          if (reset) {
            error = null;
            confirm = false;
          }
          if (changed) render();
        } catch {
          if (!disposed && generation === currentGeneration) {
            offline = true;
            render();
          }
        } finally {
          refreshing = false;
        }
      };
      const apply = async (restart: boolean) => {
        if (!draft || !base || busy || isActiveCall()) return;
        busy = true;
        generation += 1;
        error = null;
        confirm = false;
        render();
        try {
          const current = voiceSettingsStateSchema.parse(await request({ operation: "get" }));
          if (disposed) return;
          if (current.activeCall || isActiveCall()) throw new Error(m.activeCall);
          if (current.revision !== base.revision) throw new Error(m.conflict);
          if (dirty()) {
            const saved = voiceSettingsStateSchema.parse(
              await request({
                operation: "set",
                settings: draft,
                revision: base.revision,
              }),
            );
            if (disposed) return;
            state = saved;
            base = saved;
            draft = { ...saved.settings };
          }
          if (restart) await request({ operation: "restart", confirm: true });
        } catch (failure) {
          if (!disposed) error = failure instanceof Error ? failure.message : m.unavailable;
        } finally {
          busy = false;
          if (!disposed) {
            render();
            void load();
          }
        }
      };
      const render = () => {
        if (disposed) return;
        const tree = context.content.getRootNode() as Document | ShadowRoot;
        const focused = tree.activeElement;
        const focusedId = focused && context.content.contains(focused) ? focused.id : "";
        const root = h(doc, "div", { className: "settings-voice" });
        root.append(
          h(doc, "div", { className: "settings-section-label" }, m.title),
          h(doc, "p", { className: "settings-page-description" }, m.description),
        );
        if (!draft || !state) {
          root.append(h(doc, "p", { role: "status" }, offline ? m.unavailable : m.loading));
          if (offline) root.append(button(doc, m.retry, () => void load(true)));
          context.content.replaceChildren(root);
          return;
        }
        const unavailable = busy || offline || state.restart.phase === "restarting";
        const row = (
          card: HTMLElement,
          title: string,
          description: string,
          key: "chatExperience" | "chatConnection" | "workConnection",
          choices: [string, string][],
          disabled = false,
        ) => {
          const id = controlId(`voice-${key}`);
          const item = createPreferenceItem(doc, { title, description, controlId: id });
          item.item.classList.add("settings-voice__row");
          const select = h(doc, "select", {
            id,
            className: "settings-voice__select",
            "aria-describedby": item.description.id,
          });
          for (const [value, label] of choices) select.append(h(doc, "option", { value }, label));
          select.value = draft?.[key] ?? "";
          select.disabled = unavailable || disabled;
          select.addEventListener("change", () => {
            if (!draft) return;
            draft = { ...draft, [key]: select.value };
            confirm = false;
            render();
          });
          item.item.append(select);
          card.append(item.item);
        };
        const connections: [string, string][] = [
          ["desktop", m.desktop],
          ["gateway", m.gateway],
        ];
        const chat = createPreferenceGroup(doc, m.chat);
        row(chat.card, m.experience, m.chatHint, "chatExperience", [
          ["chatgpt", "ChatGPT"],
          ["codex", "Codex"],
        ]);
        row(
          chat.card,
          m.codexConnection,
          m.codexHint,
          "chatConnection",
          connections,
          draft.chatExperience !== "codex",
        );
        const work = createPreferenceGroup(doc, m.work);
        row(work.card, m.connection, m.workHint, "workConnection", connections);
        const config = createPreferenceGroup(doc, m.configuration);
        const gateway = createPreferenceItem(doc, {
          title: m.gatewayTitle,
          description: m.gatewayHint,
          controlId: preferenceId("gateway-config"),
        });
        gateway.item.classList.add("settings-voice__row");
        const configure = button(doc, m.configure, () => {
          setup = !setup;
          render();
        });
        configure.id = gateway.item.querySelector("label")?.htmlFor ?? "";
        configure.setAttribute("aria-expanded", String(setup));
        const gatewayActions = h(
          doc,
          "div",
          { className: "settings-voice__gateway-actions" },
          h(
            doc,
            "span",
            {},
            state.gatewayReady === null
              ? m.unknown
              : state.gatewayReady
                ? m.configured
                : m.needsSetup,
          ),
          configure,
        );
        gateway.item.append(gatewayActions);
        config.card.append(gateway.item);
        const hook = options.desktop ? desktopVoiceHookStatus(doc.defaultView) : "unknown";
        const hookLabel =
          hook === "active"
            ? m.hookSupported
            : hook === "pending"
              ? m.hookPending
              : hook === "unsupported"
                ? m.hookUnsupported
                : hook === "disabled"
                  ? m.hookDisabled
                  : m.unknown;
        const health = h(doc, "div", { className: "settings-voice__health" });
        health.append(
          h(
            doc,
            "p",
            {},
            `${m.gatewayStatus}: ${
              state.gatewayReady === null
                ? m.unknown
                : state.gatewayReady
                  ? m.configured
                  : m.needsSetup
            }`,
          ),
          h(
            doc,
            "p",
            {},
            `${m.preferencesStatus}: ${
              state.routesActive === true
                ? m.preferencesOn
                : state.routesActive === false
                  ? m.preferencesOff
                  : m.unknown
            }`,
          ),
          h(doc, "p", {}, `${m.hookStatus}: ${hookLabel}`),
        );
        config.card.append(health);
        if (setup) {
          const details = h(
            doc,
            "div",
            { className: "settings-voice__details" },
            h(doc, "strong", {}, m.setup),
            h(doc, "p", {}, m.setupHint),
          );
          details.append(
            h(doc, "code", {}, "~/.codex/config.toml"),
            h(
              doc,
              "p",
              {},
              "experimental_realtime_webrtc_call_base_url · experimental_realtime_ws_base_url",
            ),
          );
          config.card.append(details);
        }
        const adv = createPreferenceItem(doc, {
          title: m.advanced,
          description: m.advancedHint,
          controlId: preferenceId("voice-advanced"),
        });
        const expand = button(doc, advanced ? "⌃" : "›", () => {
          advanced = !advanced;
          render();
        });
        expand.id = adv.item.querySelector("label")?.htmlFor ?? "";
        expand.setAttribute("aria-label", m.advanced);
        expand.setAttribute("aria-expanded", String(advanced));
        adv.item.append(expand);
        config.card.append(adv.item);
        if (advanced) {
          const id = controlId("voice-inject");
          const injection = createPreferenceItem(doc, {
            title: m.inject,
            description: m.injectHint,
            controlId: id,
          });
          injection.item.classList.add("settings-voice__row");
          const toggle = createPreferenceSwitch(doc, id, injection.description.id);
          toggle.checked = draft.inject;
          toggle.disabled = unavailable || !!state.envOverride;
          toggle.addEventListener("change", () => {
            if (draft) draft = { ...draft, inject: toggle.checked };
            confirm = false;
            render();
          });
          injection.item.append(toggle);
          config.card.append(injection.item);
          if (state.envOverride || state.activeEnvOverride)
            config.card.append(
              h(doc, "p", { className: "settings-voice__details" }, m.environment),
            );
        }
        root.append(chat.group, work.group, config.group);
        const restarting = state.restart.phase === "restarting";
        const failed = state.restart.phase === "failed";
        const status = busy
          ? m.saving
          : restarting
            ? m.restarting
            : isActiveCall()
              ? m.activeCall
              : offline
                ? m.unavailable
                : dirty()
                  ? m.edited
                  : needsRestart()
                    ? m.restartNeeded
                    : state.activeInject === null
                      ? m.activeUnknown
                      : state.routesActive === false
                        ? m.pending
                        : state.routesActive === null
                          ? m.activeUnknown
                          : m.ready;
        const footer = h(
          doc,
          "div",
          { className: "settings-voice__footer" },
          h(doc, "div", { role: "status" }, h(doc, "div", {}, status), h(doc, "p", {}, m.nextCall)),
        );
        const actions = h(doc, "div", { className: "settings-voice__actions" });
        const cancel = button(doc, m.cancel, () => {
          draft = base ? { ...base.settings } : null;
          confirm = false;
          error = null;
          render();
        });
        cancel.disabled = busy || (!dirty() && !confirm);
        const submit = button(
          doc,
          failed && needsRestart() && !dirty()
            ? m.retryRestart
            : needsRestart() && state.restartAvailable
              ? m.applyRestart
              : m.apply,
          () => {
            if (needsRestart() && state?.restartAvailable) {
              confirm = true;
              render();
            } else void apply(false);
          },
          "primary",
        );
        submit.disabled =
          unavailable ||
          !!isActiveCall() ||
          (!dirty() && !(needsRestart() && state.restartAvailable));
        actions.append(cancel, submit);
        footer.append(actions);
        root.append(footer);
        if (confirm)
          root.append(
            h(
              doc,
              "div",
              { className: "settings-voice__confirmation" },
              h(doc, "p", {}, m.restartWarning),
              button(doc, m.confirm, () => void apply(true), "primary"),
              button(doc, m.cancel, () => {
                confirm = false;
                render();
              }),
            ),
          );
        if (failed)
          root.append(
            h(doc, "p", { role: "alert" }, `${m.restartFailed} ${state.restart.error ?? ""}`),
          );
        if (error) root.append(h(doc, "p", { role: "alert" }, error));
        const gatewaySelected =
          draft.workConnection === "gateway" ||
          (draft.chatExperience === "codex" && draft.chatConnection === "gateway");
        if (gatewaySelected && state.gatewayReady === false)
          root.append(h(doc, "p", { className: "settings-voice__hint" }, m.gatewayWarning));
        if (!draft.inject)
          root.append(h(doc, "p", { className: "settings-voice__hint" }, m.integrationOff));
        if (offline || base?.revision !== state.revision)
          root.append(button(doc, m.retry, () => void load(true)));
        context.content.replaceChildren(root);
        if (focusedId)
          root.querySelector<HTMLElement>(`#${focusedId}`)?.focus({ preventScroll: true });
      };
      render();
      void load();
      const timer = doc.defaultView?.setInterval(() => void load(), 3_000);
      return () => {
        disposed = true;
        if (timer !== undefined) doc.defaultView?.clearInterval(timer);
      };
    },
  });
}

function desktopVoiceHookStatus(
  win: Window | null,
): "active" | "pending" | "unsupported" | "disabled" | "unknown" {
  if (!win) return "unknown";
  const value = (win as unknown as Record<string, unknown>).__codexhostClientOwnedVoiceV1;
  if (!value || typeof value !== "object") return "unknown";
  const status = (value as { status?: unknown }).status;
  if (
    status === "active" ||
    status === "pending" ||
    status === "unsupported" ||
    status === "disabled"
  )
    return status;
  return "unknown";
}

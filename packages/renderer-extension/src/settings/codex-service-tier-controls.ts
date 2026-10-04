import type { CodexServiceTierEffect, CodexServiceTierSettings } from "@codexhost/shared-contracts";
import {
  CODEX_SERVICE_TIER_CHANGE_EVENT,
  CODEX_SERVICE_TIER_STATUS_EVENT,
  CODEX_SERVICE_TIER_STORAGE_KEY,
  readCodexServiceTierPreference,
  writeCodexServiceTierPreference,
  type CodexServiceTierStatusDetail,
} from "../renderer-codex-service-tier-preference.js";
import type { RendererSettingsMessages } from "./localization.js";
import type { RendererSettingsPageMountContext } from "./core.js";
import {
  createPreferenceGroup,
  createPreferenceItem,
  createPreferenceSwitch,
  preferenceId,
} from "./preference-ui.js";

/** The official zh-CN / en tier names, so the badge reads in the UI language. */
function tierLabels(messages: RendererSettingsMessages): Record<"fast" | "ultrafast", string> {
  return {
    fast: messages.codexServiceTierFastLabel,
    ultrafast: messages.codexServiceTierUltrafastLabel,
  };
}

/**
 * One switch plus information. The Composer's lightning button is the only
 * place a tier is chosen, so this page never presents a second selector and
 * never blocks a change behind an acknowledgment dialog: every Host answer —
 * applied, unlisted tier, official provider, failure — is shown as status and
 * as an informational hint, and the switch stays usable throughout.
 */
export function mountCodexServiceTierControls(
  context: RendererSettingsPageMountContext,
  messages: RendererSettingsMessages,
): () => void {
  const { content } = context;
  const document = content.ownerDocument;
  const owner = document.defaultView;
  if (!owner) return () => undefined;
  const { group, header, card } = createPreferenceGroup(document, messages.codexServiceTierSection);

  const status = document.createElement("div");
  status.className =
    "group/status ml-auto inline-flex items-center gap-1.5 text-xs leading-[18px] text-settings-muted data-[state=active]:text-settings-success data-[state=inactive]:text-settings-warning data-[state=failed]:text-settings-danger data-[state=unavailable]:text-settings-warning";
  const statusDot = document.createElement("span");
  statusDot.setAttribute("aria-hidden", "true");
  statusDot.className =
    "size-1.5 shrink-0 rounded-full bg-settings-subtle group-data-[state=active]/status:bg-settings-success group-data-[state=inactive]/status:bg-settings-warning group-data-[state=failed]/status:bg-settings-danger group-data-[state=unavailable]/status:bg-settings-warning";
  const statusText = document.createElement("span");
  statusText.setAttribute("role", "status");
  status.append(statusDot, statusText);
  header.append(status);

  const enabledId = preferenceId("codex-service-tier-enabled");
  const toggle = createPreferenceItem(document, {
    title: messages.codexServiceTierTitle,
    description: messages.codexServiceTierDescription,
    controlId: enabledId,
    help: { label: messages.codexServiceTierHelpLabel, lines: messages.codexServiceTierHelp },
  });
  const enabled = createPreferenceSwitch(document, enabledId, toggle.description.id);
  toggle.item.append(enabled);

  // Informational only: it never disables the switch and never claims an
  // effect the Host has not confirmed.
  const hint = document.createElement("div");
  hint.className = "text-xs leading-[18px] text-settings-muted";
  hint.hidden = true;
  const hintHost = toggle.description.parentElement ?? toggle.item;
  hintHost.append(hint);

  card.append(toggle.item);
  content.append(group);

  const statusMessages: Record<"pending" | "unavailable" | "failed", string> = {
    pending: messages.codexServiceTierPending,
    unavailable: messages.codexServiceTierUnavailable,
    failed: messages.codexServiceTierFailed,
  };
  const showHint = (lines: readonly string[]): void => {
    hint.textContent = lines.join(" ");
    hint.hidden = lines.length === 0;
  };
  const effectHint = (effect: CodexServiceTierEffect | undefined): readonly string[] => {
    if (effect?.state === "active") {
      return effect.notice === "notAdvertised"
        ? [messages.codexServiceTierToggleHint, messages.codexServiceTierNoticeNotAdvertised]
        : [messages.codexServiceTierToggleHint];
    }
    if (effect?.state === "inactive") return [messages.codexServiceTierOfficialProviderHint];
    return [];
  };
  const showStatus = (detail: CodexServiceTierStatusDetail): void => {
    if (detail.status === "applied") {
      if (detail.effect?.state === "active") {
        status.dataset.state = "active";
        status.hidden = false;
        statusText.textContent = messages.codexServiceTierActive.replace(
          "{tier}",
          tierLabels(messages)[readCodexServiceTierPreference(owner).tier],
        );
      } else if (detail.effect?.state === "inactive") {
        status.dataset.state = "inactive";
        status.hidden = false;
        statusText.textContent = messages.codexServiceTierInactiveOfficialProvider;
      } else {
        // Applied and off: the setting needs no badge.
        status.hidden = true;
        statusText.textContent = "";
      }
      showHint(effectHint(detail.effect));
      return;
    }
    // Pending, unavailable and failed all speak through the badge; a stale
    // hint would otherwise describe an effect that may no longer hold.
    status.dataset.state = detail.status;
    status.hidden = false;
    statusText.textContent = statusMessages[detail.status];
    showHint([]);
  };
  const sync = (): void => {
    enabled.checked = readCodexServiceTierPreference(owner).enabled;
  };
  const save = (settings: CodexServiceTierSettings): void => {
    if (!writeCodexServiceTierPreference(owner, settings)) {
      sync();
      showStatus({ status: "failed" });
    }
  };

  enabled.addEventListener("change", () => {
    save({ ...readCodexServiceTierPreference(owner), enabled: enabled.checked });
  });
  const statusChanged = (event: Event): void => {
    showStatus((event as CustomEvent<CodexServiceTierStatusDetail>).detail);
  };
  const storage = (event: StorageEvent): void => {
    if (event.key === CODEX_SERVICE_TIER_STORAGE_KEY || event.key === null) sync();
  };
  owner.addEventListener(CODEX_SERVICE_TIER_CHANGE_EVENT, sync);
  owner.addEventListener(CODEX_SERVICE_TIER_STATUS_EVENT, statusChanged);
  owner.addEventListener("storage", storage);
  sync();
  showStatus({ status: "pending" });
  // The switch may be the first control on this page to read the preference.
  owner.dispatchEvent(new Event(CODEX_SERVICE_TIER_CHANGE_EVENT));
  return () => {
    owner.removeEventListener(CODEX_SERVICE_TIER_CHANGE_EVENT, sync);
    owner.removeEventListener(CODEX_SERVICE_TIER_STATUS_EVENT, statusChanged);
    owner.removeEventListener("storage", storage);
  };
}

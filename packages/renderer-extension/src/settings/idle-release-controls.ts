import {
  IDLE_RELEASE_TIMEOUT_MINUTES_MAX,
  IDLE_RELEASE_TIMEOUT_MINUTES_MIN,
  idleReleaseSettingsSchema,
  type IdleReleaseSettings,
} from "@codexhost/shared-contracts";
import {
  IDLE_RELEASE_CHANGE_EVENT,
  IDLE_RELEASE_STATUS_EVENT,
  IDLE_RELEASE_STORAGE_KEY,
  readIdleReleasePreference,
  writeIdleReleasePreference,
  type IdleReleaseSyncStatus,
} from "../renderer-idle-release-preference.js";
import type { RendererSettingsMessages } from "./localization.js";
import type { RendererSettingsPageMountContext } from "./core.js";
import { mountLoadedSessionsTable, type LoadedSessionsClient } from "./loaded-sessions-table.js";
import {
  createNumberField,
  createPreferenceGroup,
  createPreferenceItem,
  createPreferenceSwitch,
  preferenceId,
} from "./preference-ui.js";

export function mountIdleReleaseControls(
  context: RendererSettingsPageMountContext,
  messages: RendererSettingsMessages,
  getLoadedSessionsClient: () => LoadedSessionsClient | null,
): () => void {
  const { content } = context;
  const document = content.ownerDocument;
  const owner = document.defaultView;
  if (!owner) return () => undefined;
  const { group, header, card } = createPreferenceGroup(document, messages.idleReleaseSection);

  const status = document.createElement("div");
  status.className =
    "group/status ml-auto inline-flex items-center gap-1.5 text-xs leading-[18px] text-settings-muted data-[state=failed]:text-settings-danger data-[state=unavailable]:text-settings-warning";
  const statusDot = document.createElement("span");
  statusDot.setAttribute("aria-hidden", "true");
  statusDot.className =
    "size-1.5 shrink-0 rounded-full bg-settings-subtle group-data-[state=failed]/status:bg-settings-danger group-data-[state=unavailable]/status:bg-settings-warning";
  const statusText = document.createElement("span");
  statusText.setAttribute("role", "status");
  status.append(statusDot, statusText);
  header.append(status);

  const enabledId = preferenceId("idle-release-enabled");
  const toggle = createPreferenceItem(document, {
    title: messages.idleReleaseTitle,
    description: messages.idleReleaseDescription,
    controlId: enabledId,
    help: { label: messages.idleReleaseHelpLabel, lines: messages.idleReleaseHelp },
  });
  const enabled = createPreferenceSwitch(document, enabledId, toggle.description.id);
  toggle.item.append(enabled);

  const minutesId = preferenceId("idle-release-minutes");
  const timeout = createPreferenceItem(document, {
    title: messages.idleReleaseTimeout,
    description: messages.idleReleaseTimeoutDescription,
    controlId: minutesId,
  });
  const { field, control: minutes } = createNumberField(document, {
    id: minutesId,
    describedBy: timeout.description.id,
    unit: messages.idleReleaseMinutes,
    min: IDLE_RELEASE_TIMEOUT_MINUTES_MIN,
    max: IDLE_RELEASE_TIMEOUT_MINUTES_MAX,
  });
  timeout.item.append(field);
  timeout.item.id = preferenceId("idle-release-timeout");
  enabled.setAttribute("aria-controls", timeout.item.id);
  card.append(toggle.item, timeout.item);
  content.append(group);
  const disposeTable = mountLoadedSessionsTable(
    { ...context, content: card },
    messages,
    getLoadedSessionsClient,
  );

  const statusMessages: Record<Exclude<IdleReleaseSyncStatus, "applied">, string> = {
    pending: messages.idleReleasePending,
    unavailable: messages.idleReleaseUnavailable,
    failed: messages.idleReleaseFailed,
  };
  const showStatus = (value: IdleReleaseSyncStatus): void => {
    status.dataset.state = value;
    // An applied setting needs no message; only pending, unsupported or failed sync is shown.
    status.hidden = value === "applied";
    statusText.textContent = value === "applied" ? "" : statusMessages[value];
  };
  const setInvalid = (invalid: boolean): void => {
    field.dataset.invalid = String(invalid);
    timeout.description.dataset.invalid = String(invalid);
    timeout.description.textContent = invalid
      ? messages.idleReleaseInvalid
      : messages.idleReleaseTimeoutDescription;
    minutes.setAttribute("aria-invalid", String(invalid));
    minutes.setCustomValidity(invalid ? messages.idleReleaseInvalid : "");
  };
  const sync = (): void => {
    const settings = readIdleReleasePreference(owner);
    enabled.checked = settings.enabled;
    // The timeout only matters while release is enabled; hiding it discards an invalid draft.
    timeout.item.hidden = !settings.enabled;
    if (!settings.enabled && minutes.getAttribute("aria-invalid") === "true") setInvalid(false);
    // Otherwise keep an invalid draft visible until the user corrects it.
    if (minutes.getAttribute("aria-invalid") !== "true") {
      minutes.value = String(settings.timeoutMinutes);
    }
  };
  const save = (settings: IdleReleaseSettings): void => {
    if (writeIdleReleasePreference(owner, settings)) return;
    sync();
    showStatus("failed");
  };

  enabled.addEventListener("change", () => {
    save({ ...readIdleReleasePreference(owner), enabled: enabled.checked });
  });
  minutes.addEventListener("change", () => {
    const parsed = idleReleaseSettingsSchema.safeParse({
      enabled: readIdleReleasePreference(owner).enabled,
      timeoutMinutes: minutes.valueAsNumber,
    });
    setInvalid(!parsed.success);
    if (parsed.success) save(parsed.data);
  });
  minutes.addEventListener("input", () => {
    if (minutes.getAttribute("aria-invalid") === "true") setInvalid(false);
  });
  const storage = (event: StorageEvent): void => {
    if (event.key === IDLE_RELEASE_STORAGE_KEY || event.key === null) sync();
  };
  const onStatus = (event: Event): void =>
    showStatus((event as CustomEvent<IdleReleaseSyncStatus>).detail);
  owner.addEventListener(IDLE_RELEASE_CHANGE_EVENT, sync);
  owner.addEventListener(IDLE_RELEASE_STATUS_EVENT, onStatus);
  owner.addEventListener("storage", storage);
  sync();
  showStatus("pending");
  // Ask the installed connection synchronizer to report whether the saved setting was applied.
  owner.dispatchEvent(new Event(IDLE_RELEASE_CHANGE_EVENT));
  return () => {
    disposeTable();
    owner.removeEventListener(IDLE_RELEASE_CHANGE_EVENT, sync);
    owner.removeEventListener(IDLE_RELEASE_STATUS_EVENT, onStatus);
    owner.removeEventListener("storage", storage);
  };
}

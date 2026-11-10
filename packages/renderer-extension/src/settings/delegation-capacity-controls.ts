import {
  DELEGATION_CAPACITY_MAX_RUNNING_MAX,
  DELEGATION_CAPACITY_MAX_RUNNING_MIN,
  delegationCapacitySettingsSchema,
  type DelegationCapacitySettings,
} from "@codexhost/shared-contracts";
import {
  DELEGATION_CAPACITY_CHANGE_EVENT,
  DELEGATION_CAPACITY_STATUS_EVENT,
  DELEGATION_CAPACITY_STORAGE_KEY,
  readDelegationCapacityPreference,
  writeDelegationCapacityPreference,
  type DelegationCapacitySyncStatus,
} from "../renderer-delegation-capacity-preference.js";
import type { RendererSettingsMessages } from "./localization.js";
import type { RendererSettingsPageMountContext } from "./core.js";
import {
  createNumberField,
  createPreferenceGroup,
  createPreferenceItem,
  createPreferenceSwitch,
  preferenceId,
} from "./preference-ui.js";

export function mountDelegationCapacityControls(
  context: RendererSettingsPageMountContext,
  messages: RendererSettingsMessages,
): () => void {
  const { content } = context;
  const document = content.ownerDocument;
  const owner = document.defaultView;
  if (!owner) return () => undefined;
  const { group, header, card } = createPreferenceGroup(
    document,
    messages.delegationCapacitySection,
  );

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

  const enabledId = preferenceId("delegation-capacity-enabled");
  const toggle = createPreferenceItem(document, {
    title: messages.delegationCapacityTitle,
    description: messages.delegationCapacityDescription,
    controlId: enabledId,
    help: { label: messages.delegationCapacityHelpLabel, lines: messages.delegationCapacityHelp },
  });
  const enabled = createPreferenceSwitch(document, enabledId, toggle.description.id);
  toggle.item.append(enabled);

  const limitId = preferenceId("delegation-capacity-max-running");
  const limit = createPreferenceItem(document, {
    title: messages.delegationCapacityLimit,
    description: messages.delegationCapacityLimitDescription,
    controlId: limitId,
  });
  const { field, control: maxRunning } = createNumberField(document, {
    id: limitId,
    describedBy: limit.description.id,
    unit: messages.delegationCapacityUnit,
    min: DELEGATION_CAPACITY_MAX_RUNNING_MIN,
    max: DELEGATION_CAPACITY_MAX_RUNNING_MAX,
  });
  limit.item.append(field);
  limit.item.id = preferenceId("delegation-capacity-limit");
  enabled.setAttribute("aria-controls", limit.item.id);
  card.append(toggle.item, limit.item);
  content.append(group);

  const statusMessages: Record<Exclude<DelegationCapacitySyncStatus, "applied">, string> = {
    pending: messages.delegationCapacityPending,
    unavailable: messages.delegationCapacityUnavailable,
    failed: messages.delegationCapacityFailed,
  };
  const showStatus = (value: DelegationCapacitySyncStatus): void => {
    status.dataset.state = value;
    status.hidden = value === "applied";
    statusText.textContent = value === "applied" ? "" : statusMessages[value];
  };
  const setInvalid = (invalid: boolean): void => {
    field.dataset.invalid = String(invalid);
    limit.description.dataset.invalid = String(invalid);
    limit.description.textContent = invalid
      ? messages.delegationCapacityInvalid
      : messages.delegationCapacityLimitDescription;
    maxRunning.setAttribute("aria-invalid", String(invalid));
    maxRunning.setCustomValidity(invalid ? messages.delegationCapacityInvalid : "");
  };
  const sync = (): void => {
    const settings = readDelegationCapacityPreference(owner);
    enabled.checked = settings.enabled;
    limit.item.hidden = !settings.enabled;
    if (!settings.enabled && maxRunning.getAttribute("aria-invalid") === "true") setInvalid(false);
    if (maxRunning.getAttribute("aria-invalid") !== "true") {
      maxRunning.value = String(settings.maxRunning);
    }
  };
  const save = (settings: DelegationCapacitySettings): void => {
    if (writeDelegationCapacityPreference(owner, settings)) return;
    sync();
    showStatus("failed");
  };

  enabled.addEventListener("change", () => {
    save({ ...readDelegationCapacityPreference(owner), enabled: enabled.checked });
  });
  maxRunning.addEventListener("change", () => {
    const parsed = delegationCapacitySettingsSchema.safeParse({
      enabled: readDelegationCapacityPreference(owner).enabled,
      maxRunning: maxRunning.valueAsNumber,
    });
    setInvalid(!parsed.success);
    if (parsed.success) save(parsed.data);
  });
  maxRunning.addEventListener("input", () => {
    if (maxRunning.getAttribute("aria-invalid") === "true") setInvalid(false);
  });
  const storage = (event: StorageEvent): void => {
    if (event.key === DELEGATION_CAPACITY_STORAGE_KEY || event.key === null) sync();
  };
  const onStatus = (event: Event): void =>
    showStatus((event as CustomEvent<DelegationCapacitySyncStatus>).detail);
  owner.addEventListener(DELEGATION_CAPACITY_CHANGE_EVENT, sync);
  owner.addEventListener(DELEGATION_CAPACITY_STATUS_EVENT, onStatus);
  owner.addEventListener("storage", storage);
  sync();
  showStatus("pending");
  // Ask the installed connection synchronizer to report whether the saved setting was applied.
  owner.dispatchEvent(new Event(DELEGATION_CAPACITY_CHANGE_EVENT));
  return () => {
    owner.removeEventListener(DELEGATION_CAPACITY_CHANGE_EVENT, sync);
    owner.removeEventListener(DELEGATION_CAPACITY_STATUS_EVENT, onStatus);
    owner.removeEventListener("storage", storage);
  };
}

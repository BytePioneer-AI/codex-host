import {
  harnessIdSchema,
  type HarnessAuthenticationType,
  type HarnessConfigurationEntrySummary,
  type HarnessConfigurationInspectParams,
  type HarnessConfigurationProfileInput,
  type HarnessConfigurationProfileSummary,
  type HarnessConfigurationSaveParams,
  type HarnessConfigurationSaveResult,
  type HarnessConfigurationSnapshot,
} from "@codexhost/shared-contracts";

import type { ExternalRendererAgent } from "../agent-selection-state.js";
import { createRendererAgentIcon, RENDERER_AGENT_LABELS } from "../renderer-agent-icon.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";

const CONFIGURABLE_HARNESSES = [
  "pi",
  "claude-code",
  "deepseek-harness",
  "grok",
  "gemini",
  "omp",
] as const satisfies readonly ExternalRendererAgent[];

const AUTHENTICATION_TYPES = [
  "oauth",
  "official-api-key",
  "third-party-gateway",
  "environment",
  "none",
] as const satisfies readonly HarnessAuthenticationType[];

export interface RendererHarnessConfigurationClient {
  inspectHarnessConfiguration(
    input: HarnessConfigurationInspectParams,
  ): Promise<HarnessConfigurationSnapshot>;
  saveHarnessConfiguration(
    input: HarnessConfigurationSaveParams,
  ): Promise<HarnessConfigurationSaveResult>;
}

interface PageCopy {
  readonly description: string;
  readonly loading: string;
  readonly unavailable: string;
  readonly retry: string;
  readonly enabled: string;
  readonly disabled: string;
  readonly profile: string;
  readonly profileName: string;
  readonly addProfile: string;
  readonly removeProfile: string;
  readonly authentication: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiKeyPlaceholder: string;
  readonly apiKeyConfigured: string;
  readonly apiKeyNotConfigured: string;
  readonly clearApiKey: string;
  readonly apiKeyEnvironment: string;
  readonly model: string;
  readonly command: string;
  readonly advanced: string;
  readonly environment: string;
  readonly environmentName: string;
  readonly environmentValue: string;
  readonly environmentPreserved: string;
  readonly addEnvironment: string;
  readonly removeEnvironment: string;
  readonly save: string;
  readonly saving: string;
  readonly saved: string;
  readonly restartRequired: string;
  readonly readOnly: string;
  readonly managedPath: string;
  readonly authLabels: Readonly<Record<HarnessAuthenticationType, string>>;
}

const PAGE_COPY: Readonly<Record<RendererSettingsMessages["locale"], PageCopy>> = {
  en: {
    description:
      "Manage credentials and endpoints centrally. Each Harness still runs through its native runtime.",
    loading: "Loading Harness configuration...",
    unavailable: "Harness configuration is unavailable on this Host.",
    retry: "Retry",
    enabled: "Configuration enabled",
    disabled: "Configuration disabled",
    profile: "Active profile",
    profileName: "Profile name",
    addProfile: "Add profile",
    removeProfile: "Remove profile",
    authentication: "Authentication",
    baseUrl: "Base URL",
    apiKey: "API key",
    apiKeyPlaceholder: "Leave blank to keep the current key",
    apiKeyConfigured: "A key is configured",
    apiKeyNotConfigured: "No stored API key",
    clearApiKey: "Remove the stored API key",
    apiKeyEnvironment: "API key environment variable",
    model: "Model",
    command: "Harness command",
    advanced: "Advanced",
    environment: "Environment variables",
    environmentName: "Name",
    environmentValue: "Value",
    environmentPreserved: "Leave blank to keep the current value",
    addEnvironment: "Add variable",
    removeEnvironment: "Remove variable",
    save: "Save configuration",
    saving: "Saving...",
    saved: "Configuration saved.",
    restartRequired: "Restart codexhost to apply this configuration.",
    readOnly: "This configuration source is read-only.",
    managedPath: "Configuration file",
    authLabels: {
      none: "Not configured",
      oauth: "OAuth",
      "official-api-key": "Official API key",
      "third-party-gateway": "Third-party gateway",
      environment: "Environment reference",
    },
  },
  "zh-CN": {
    description: "集中管理凭据和端点。实际模型能力仍由各自原生 Harness 执行。",
    loading: "正在加载 Harness 配置...",
    unavailable: "当前 Host 不支持 Harness 配置管理。",
    retry: "重试",
    enabled: "配置已启用",
    disabled: "配置已停用",
    profile: "当前配置",
    profileName: "配置名称",
    addProfile: "新增配置",
    removeProfile: "删除配置",
    authentication: "认证方式",
    baseUrl: "Base URL",
    apiKey: "API Key",
    apiKeyPlaceholder: "留空以保留当前密钥",
    apiKeyConfigured: "已配置密钥",
    apiKeyNotConfigured: "未保存 API Key",
    clearApiKey: "删除已保存的 API Key",
    apiKeyEnvironment: "API Key 环境变量",
    model: "模型",
    command: "Harness 命令",
    advanced: "高级配置",
    environment: "环境变量",
    environmentName: "变量名",
    environmentValue: "变量值",
    environmentPreserved: "留空以保留当前值",
    addEnvironment: "添加变量",
    removeEnvironment: "删除变量",
    save: "保存配置",
    saving: "正在保存...",
    saved: "配置已保存。",
    restartRequired: "请重启 codexhost 以应用此配置。",
    readOnly: "当前配置来源为只读。",
    managedPath: "配置文件",
    authLabels: {
      none: "未配置",
      oauth: "OAuth",
      "official-api-key": "官方 API Key",
      "third-party-gateway": "第三方中转",
      environment: "环境变量引用",
    },
  },
};

function inputField(
  document: Document,
  labelText: string,
  input: HTMLInputElement | HTMLSelectElement,
): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "settings-harness-field";
  const text = document.createElement("span");
  text.textContent = labelText;
  label.append(text, input);
  return label;
}

function optionalValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function fallbackEntry(harnessId: ExternalRendererAgent): HarnessConfigurationEntrySummary {
  return {
    harnessId: harnessIdSchema.parse(harnessId),
    enabled: false,
    activeProfileId: "default",
    profiles: [
      {
        id: "default",
        label: "Default",
        authType: "none",
        apiKeyConfigured: false,
        environmentKeys: [],
      },
    ],
  };
}

function profileInput(
  profile: HarnessConfigurationProfileSummary,
): HarnessConfigurationProfileInput {
  return {
    id: profile.id,
    label: profile.label,
    authType: profile.authType,
    ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
    ...(profile.apiKeyEnv ? { apiKeyEnv: profile.apiKeyEnv } : {}),
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.models ? { models: [...profile.models] } : {}),
    ...(profile.command ? { command: profile.command } : {}),
  };
}

export function supportsFirstClassEndpointConfiguration(harnessId: ExternalRendererAgent): boolean {
  return (
    harnessId === "gemini" ||
    harnessId === "claude-code" ||
    harnessId === "grok" ||
    harnessId === "deepseek-harness"
  );
}

function supportsProfileModelConfiguration(harnessId: ExternalRendererAgent): boolean {
  return harnessId === "gemini" || harnessId === "claude-code" || harnessId === "grok";
}

export function editableAuthenticationTypesForHarness(
  harnessId: ExternalRendererAgent,
  current: HarnessAuthenticationType,
): readonly HarnessAuthenticationType[] {
  const supported: readonly HarnessAuthenticationType[] =
    harnessId === "deepseek-harness"
      ? (["official-api-key", "third-party-gateway", "environment", "none"] as const)
      : supportsFirstClassEndpointConfiguration(harnessId)
        ? AUTHENTICATION_TYPES
        : (["oauth", "environment", "none"] as const);
  return supported.includes(current) ? supported : [current, ...supported];
}

export function appendHarnessConfigurationProfile(
  profiles: readonly HarnessConfigurationProfileSummary[],
): {
  readonly activeProfileId: string;
  readonly profiles: HarnessConfigurationProfileSummary[];
} {
  const ids = new Set(profiles.map(({ id }) => id));
  let index = profiles.length + 1;
  while (ids.has(`profile-${index}`)) index += 1;
  const id = `profile-${index}`;
  return {
    activeProfileId: id,
    profiles: [
      ...profiles,
      {
        id,
        label: `Profile ${index}`,
        authType: "none",
        apiKeyConfigured: false,
        environmentKeys: [],
      },
    ],
  };
}

export function removeHarnessConfigurationProfile(
  profiles: readonly HarnessConfigurationProfileSummary[],
  profileId: string,
): {
  readonly activeProfileId: string;
  readonly profiles: HarnessConfigurationProfileSummary[];
} | null {
  if (profiles.length <= 1) return null;
  const remaining = profiles.filter(({ id }) => id !== profileId);
  const activeProfileId = remaining[0]?.id;
  return activeProfileId ? { activeProfileId, profiles: remaining } : null;
}

export interface HarnessConfigurationProfileEdits {
  readonly label: string;
  readonly authType: HarnessAuthenticationType;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly clearApiKey: boolean;
  readonly apiKeyEnv: string;
  readonly model: string;
  readonly command: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly presentEnvironmentKeys: ReadonlySet<string>;
}

export function applyHarnessConfigurationProfileEdits(
  profile: HarnessConfigurationProfileSummary,
  edits: HarnessConfigurationProfileEdits,
): HarnessConfigurationProfileInput {
  const removeEnvironmentKeys = profile.environmentKeys.filter(
    (key) => !edits.presentEnvironmentKeys.has(key),
  );
  return {
    id: profile.id,
    label: optionalValue(edits.label) ?? profile.label,
    authType: edits.authType,
    ...(optionalValue(edits.baseUrl) ? { baseUrl: edits.baseUrl.trim() } : {}),
    ...(optionalValue(edits.apiKey) ? { apiKey: edits.apiKey } : {}),
    ...(edits.clearApiKey ? { clearApiKey: true } : {}),
    ...(optionalValue(edits.apiKeyEnv) ? { apiKeyEnv: edits.apiKeyEnv.trim() } : {}),
    ...(optionalValue(edits.model) ? { model: edits.model.trim() } : {}),
    ...(profile.models ? { models: [...profile.models] } : {}),
    ...(optionalValue(edits.command) ? { command: edits.command.trim() } : {}),
    ...(Object.keys(edits.environment).length > 0 ? { environment: { ...edits.environment } } : {}),
    ...(removeEnvironmentKeys.length > 0 ? { removeEnvironmentKeys } : {}),
  };
}

function createStatus(document: Document): HTMLElement {
  const status = document.createElement("div");
  status.className = "settings-harness-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  return status;
}

export function createHarnessConfigurationSettingsPage(
  messages: RendererSettingsMessages,
  getClient: () => RendererHarnessConfigurationClient | null,
): RendererSettingsPageDefinition {
  const copy = PAGE_COPY[messages.locale];
  return Object.freeze({
    id: "harnesses",
    label: messages.pageLabels.harnesses,
    icon: "gateway",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const heading = document.createElement("div");
      heading.className = "settings-section-label";
      heading.textContent = messages.pageLabels.harnesses;
      const description = document.createElement("p");
      description.className = "settings-page-description";
      description.textContent = copy.description;
      const body = document.createElement("div");
      body.className = "settings-harness-loading";
      body.setAttribute("aria-busy", "true");
      body.textContent = copy.loading;
      context.content.append(heading, description, body);

      const renderFailure = (): void => {
        body.className = "settings-harness-error";
        body.removeAttribute("aria-busy");
        body.replaceChildren();
        const message = document.createElement("p");
        message.textContent = copy.unavailable;
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "settings-command-button settings-command-button--secondary";
        retry.textContent = copy.retry;
        retry.addEventListener("click", () => void load());
        body.append(message, retry);
      };

      const renderSnapshot = (
        snapshot: HarnessConfigurationSnapshot,
        preferredHarness: ExternalRendererAgent = CONFIGURABLE_HARNESSES[0],
        notice = "",
      ): void => {
        body.className = "settings-harness-layout";
        body.removeAttribute("aria-busy");
        body.replaceChildren();
        const entries = new Map<string, HarnessConfigurationEntrySummary>(
          snapshot.harnesses.map((entry) => [entry.harnessId, entry]),
        );
        const list = document.createElement("div");
        list.className = "settings-harness-list";
        list.setAttribute("role", "list");
        const editor = document.createElement("div");
        editor.className = "settings-harness-editor";
        const metadata = document.createElement("div");
        metadata.className = "settings-harness-metadata";
        metadata.textContent = `${copy.managedPath}: ${snapshot.path}`;
        editor.append(metadata);
        let selectedHarness = preferredHarness;

        const renderEditor = (harnessId: ExternalRendererAgent): void => {
          selectedHarness = harnessId;
          for (const row of list.querySelectorAll<HTMLButtonElement>(".settings-harness-row")) {
            row.setAttribute(
              "aria-current",
              row.dataset.harnessId === harnessId ? "true" : "false",
            );
          }
          let entry = entries.get(harnessId) ?? fallbackEntry(harnessId);
          editor.replaceChildren(metadata);
          const form = document.createElement("form");
          form.className = "settings-harness-form";
          const header = document.createElement("div");
          header.className = "settings-harness-editor__header";
          const identity = document.createElement("div");
          identity.className = "settings-harness-editor__identity";
          identity.append(createRendererAgentIcon(harnessId, 24, document));
          const title = document.createElement("strong");
          title.textContent = RENDERER_AGENT_LABELS[harnessId];
          identity.append(title);
          const enabledLabel = document.createElement("label");
          enabledLabel.className = "settings-harness-enabled";
          const enabled = document.createElement("input");
          enabled.type = "checkbox";
          enabled.checked = entry.enabled;
          enabled.disabled = !snapshot.writable;
          const enabledText = document.createElement("span");
          const updateEnabledText = (): void => {
            enabledText.textContent = enabled.checked ? copy.enabled : copy.disabled;
          };
          updateEnabledText();
          enabled.addEventListener("change", updateEnabledText);
          enabledLabel.append(enabled, enabledText);
          header.append(identity, enabledLabel);

          const profileSelect = document.createElement("select");
          for (const profile of entry.profiles) {
            const option = document.createElement("option");
            option.value = profile.id;
            option.textContent = profile.label;
            profileSelect.append(option);
          }
          profileSelect.value = entry.activeProfileId;
          profileSelect.disabled = !snapshot.writable;
          const profileControl = document.createElement("div");
          profileControl.className = "settings-harness-profile-control";
          const profileActions = document.createElement("div");
          profileActions.className = "settings-harness-profile-actions";
          const addProfile = document.createElement("button");
          addProfile.type = "button";
          addProfile.className = "settings-harness-icon-action";
          addProfile.title = copy.addProfile;
          addProfile.setAttribute("aria-label", copy.addProfile);
          addProfile.append(createRendererSettingsIcon("plus", 15));
          addProfile.disabled = !snapshot.writable;
          const removeProfile = document.createElement("button");
          removeProfile.type = "button";
          removeProfile.className = "settings-harness-icon-action";
          removeProfile.title = copy.removeProfile;
          removeProfile.setAttribute("aria-label", copy.removeProfile);
          removeProfile.append(createRendererSettingsIcon("trash", 15));
          removeProfile.disabled = !snapshot.writable || entry.profiles.length === 1;
          profileActions.append(addProfile, removeProfile);
          profileControl.append(inputField(document, copy.profile, profileSelect), profileActions);
          addProfile.addEventListener("click", () => {
            const appended = appendHarnessConfigurationProfile(entry.profiles);
            entry = {
              ...entry,
              enabled: enabled.checked,
              ...appended,
            };
            entries.set(harnessId, entry);
            renderEditor(harnessId);
          });
          removeProfile.addEventListener("click", () => {
            const removed = removeHarnessConfigurationProfile(entry.profiles, profileSelect.value);
            if (!removed) return;
            entry = {
              ...entry,
              enabled: enabled.checked,
              ...removed,
            };
            entries.set(harnessId, entry);
            renderEditor(harnessId);
          });
          const fields = document.createElement("div");
          fields.className = "settings-harness-fields";
          const status = createStatus(document);

          const renderProfile = (): void => {
            fields.replaceChildren();
            status.textContent = "";
            const profile =
              entry.profiles.find(({ id }) => id === profileSelect.value) ?? entry.profiles[0];
            if (!profile) return;
            const hasFirstClassEndpointConfiguration =
              supportsFirstClassEndpointConfiguration(harnessId);
            const profileName = document.createElement("input");
            profileName.value = profile.label;
            profileName.required = true;
            profileName.disabled = !snapshot.writable;
            const authType = document.createElement("select");
            const visibleAuthenticationTypes = editableAuthenticationTypesForHarness(
              harnessId,
              profile.authType,
            );
            for (const value of visibleAuthenticationTypes) {
              const option = document.createElement("option");
              option.value = value;
              option.textContent = copy.authLabels[value];
              authType.append(option);
            }
            authType.value = profile.authType;
            authType.disabled = !snapshot.writable;
            const baseUrl = document.createElement("input");
            baseUrl.type = "url";
            baseUrl.value = profile.baseUrl ?? "";
            baseUrl.placeholder = "https://api.example.com";
            baseUrl.disabled = !snapshot.writable;
            const apiKey = document.createElement("input");
            apiKey.type = "password";
            apiKey.autocomplete = "new-password";
            apiKey.placeholder = profile.apiKeyConfigured
              ? `${copy.apiKeyPlaceholder}${profile.apiKeyHint ? ` (${profile.apiKeyHint})` : ""}`
              : copy.apiKey;
            apiKey.disabled = !snapshot.writable;
            const clearKey = document.createElement("input");
            clearKey.type = "checkbox";
            clearKey.disabled = !snapshot.writable || !profile.apiKeyConfigured;
            const clearKeyLabel = document.createElement("label");
            clearKeyLabel.className = "settings-harness-check";
            const clearKeyText = document.createElement("span");
            clearKeyText.textContent = profile.apiKeyConfigured
              ? copy.clearApiKey
              : copy.apiKeyNotConfigured;
            clearKeyLabel.append(clearKey, clearKeyText);
            apiKey.addEventListener("input", () => {
              if (apiKey.value.length > 0) clearKey.checked = false;
            });
            clearKey.addEventListener("change", () => {
              if (clearKey.checked) apiKey.value = "";
            });
            const apiKeyEnv = document.createElement("input");
            apiKeyEnv.value = profile.apiKeyEnv ?? "";
            apiKeyEnv.placeholder = "GEMINI_API_KEY";
            apiKeyEnv.pattern = "[A-Za-z_][A-Za-z0-9_]*";
            apiKeyEnv.disabled = !snapshot.writable;
            const model = document.createElement("input");
            model.value = profile.model ?? "";
            model.disabled = !snapshot.writable;
            const command = document.createElement("input");
            command.value = profile.command ?? "";
            command.disabled = !snapshot.writable;

            const authFields = document.createElement("div");
            authFields.className = "settings-harness-auth-fields";
            const renderAuthFields = (): void => {
              authFields.replaceChildren();
              const value = authType.value as HarnessAuthenticationType;
              if (hasFirstClassEndpointConfiguration && value === "third-party-gateway") {
                baseUrl.required = true;
                authFields.append(inputField(document, copy.baseUrl, baseUrl));
              } else if (hasFirstClassEndpointConfiguration && value === "official-api-key") {
                baseUrl.required = false;
              }
              if (
                hasFirstClassEndpointConfiguration &&
                (value === "official-api-key" || value === "third-party-gateway")
              ) {
                authFields.append(inputField(document, copy.apiKey, apiKey), clearKeyLabel);
              }
              if (value === "environment") {
                authFields.append(inputField(document, copy.apiKeyEnvironment, apiKeyEnv));
              }
            };
            authType.addEventListener("change", renderAuthFields);
            renderAuthFields();

            const advanced = document.createElement("details");
            advanced.className = "settings-harness-advanced";
            const summary = document.createElement("summary");
            summary.textContent = copy.advanced;
            const advancedFields = document.createElement("div");
            advancedFields.className = "settings-harness-advanced__fields";
            advancedFields.append(inputField(document, copy.command, command));
            const environmentHeading = document.createElement("strong");
            environmentHeading.textContent = copy.environment;
            const environmentRows = document.createElement("div");
            environmentRows.className = "settings-harness-environment";
            const addEnvironmentRow = (name = "", existing = false): void => {
              const row = document.createElement("div");
              row.className = "settings-harness-environment-row";
              row.dataset.existing = existing ? "true" : "false";
              const nameInput = document.createElement("input");
              nameInput.setAttribute("aria-label", copy.environmentName);
              nameInput.placeholder = copy.environmentName;
              nameInput.value = name;
              nameInput.pattern = "[A-Za-z_][A-Za-z0-9_]*";
              nameInput.disabled = !snapshot.writable;
              const valueInput = document.createElement("input");
              valueInput.type = "password";
              valueInput.autocomplete = "new-password";
              valueInput.setAttribute("aria-label", copy.environmentValue);
              valueInput.placeholder = existing ? copy.environmentPreserved : copy.environmentValue;
              valueInput.disabled = !snapshot.writable;
              const remove = document.createElement("button");
              remove.type = "button";
              remove.className = "settings-harness-environment-remove";
              remove.title = copy.removeEnvironment;
              remove.setAttribute(
                "aria-label",
                `${copy.removeEnvironment}: ${name || copy.environmentName}`,
              );
              remove.disabled = !snapshot.writable;
              remove.append(createRendererSettingsIcon("trash", 14));
              remove.addEventListener("click", () => row.remove());
              row.append(nameInput, valueInput, remove);
              environmentRows.append(row);
            };
            for (const key of profile.environmentKeys) addEnvironmentRow(key, true);
            const addEnvironment = document.createElement("button");
            addEnvironment.type = "button";
            addEnvironment.className =
              "settings-command-button settings-command-button--secondary settings-harness-add-environment";
            addEnvironment.textContent = copy.addEnvironment;
            addEnvironment.disabled = !snapshot.writable;
            addEnvironment.addEventListener("click", () => addEnvironmentRow());
            advancedFields.append(environmentHeading, environmentRows, addEnvironment);
            advanced.append(summary, advancedFields);

            fields.append(
              inputField(document, copy.profileName, profileName),
              inputField(document, copy.authentication, authType),
              authFields,
            );
            if (supportsProfileModelConfiguration(harnessId)) {
              fields.append(inputField(document, copy.model, model));
            }
            fields.append(advanced);

            form.onsubmit = (event) => {
              event.preventDefault();
              if (!snapshot.writable) return;
              const environment: Record<string, string> = {};
              const presentEnvironmentKeys = new Set<string>();
              for (const row of environmentRows.querySelectorAll<HTMLElement>(
                ".settings-harness-environment-row",
              )) {
                const inputs = row.querySelectorAll<HTMLInputElement>("input");
                const name = optionalValue(inputs[0]?.value ?? "");
                const value = inputs[1]?.value ?? "";
                if (!name) continue;
                presentEnvironmentKeys.add(name);
                if (value.length > 0) environment[name] = value;
              }
              const selectedProfile = applyHarnessConfigurationProfileEdits(profile, {
                label: profileName.value,
                authType: authType.value as HarnessAuthenticationType,
                baseUrl: baseUrl.value,
                apiKey: apiKey.value,
                clearApiKey: clearKey.checked,
                apiKeyEnv: apiKeyEnv.value,
                model: model.value,
                command: command.value,
                environment,
                presentEnvironmentKeys,
              });
              const input: HarnessConfigurationSaveParams = {
                harnessId: harnessIdSchema.parse(harnessId),
                enabled: enabled.checked,
                activeProfileId: profile.id,
                profiles: entry.profiles.map((candidate) =>
                  candidate.id === profile.id ? selectedProfile : profileInput(candidate),
                ),
              };
              const client = getClient();
              if (!client) {
                renderFailure();
                return;
              }
              submit.disabled = true;
              status.textContent = copy.saving;
              void context.runLatest(() => client.saveHarnessConfiguration(input), {
                success(result) {
                  submit.disabled = false;
                  const savedNotice = result.snapshot.restartRequired
                    ? `${copy.saved} ${copy.restartRequired}`
                    : copy.saved;
                  renderSnapshot(result.snapshot, harnessId, savedNotice);
                },
                failure() {
                  submit.disabled = false;
                  status.textContent = copy.unavailable;
                },
              });
            };
          };

          profileSelect.addEventListener("change", renderProfile);
          const submit = document.createElement("button");
          submit.type = "submit";
          submit.className = "settings-command-button settings-harness-save";
          submit.textContent = copy.save;
          submit.disabled = !snapshot.writable;
          form.append(header, profileControl, fields, status, submit);
          if (!snapshot.writable) status.textContent = copy.readOnly;
          editor.append(form);
          renderProfile();
          if (notice) status.textContent = notice;
        };

        for (const harnessId of CONFIGURABLE_HARNESSES) {
          const entry = entries.get(harnessId) ?? fallbackEntry(harnessId);
          const active =
            entry.profiles.find(({ id }) => id === entry.activeProfileId) ?? entry.profiles[0];
          const row = document.createElement("button");
          row.type = "button";
          row.className = "settings-harness-row";
          row.dataset.harnessId = harnessId;
          row.setAttribute("role", "listitem");
          const identity = document.createElement("span");
          identity.className = "settings-harness-row__identity";
          identity.append(createRendererAgentIcon(harnessId, 20, document));
          const label = document.createElement("strong");
          label.textContent = RENDERER_AGENT_LABELS[harnessId];
          identity.append(label);
          const state = document.createElement("span");
          state.className = "settings-harness-row__state";
          const stateLabel = document.createElement("span");
          stateLabel.textContent = entry.enabled ? copy.enabled : copy.disabled;
          const authLabel = document.createElement("small");
          authLabel.textContent = copy.authLabels[active?.authType ?? "none"];
          state.append(stateLabel, authLabel);
          row.append(identity, state);
          row.addEventListener("click", () => renderEditor(harnessId));
          list.append(row);
        }
        body.append(list, editor);
        renderEditor(selectedHarness);
      };

      const load = (): Promise<void> => {
        const client = getClient();
        if (!client) {
          renderFailure();
          return Promise.resolve();
        }
        body.className = "settings-harness-loading";
        body.setAttribute("aria-busy", "true");
        body.textContent = copy.loading;
        return context.runLatest(() => client.inspectHarnessConfiguration({}), {
          success: renderSnapshot,
          failure: renderFailure,
        });
      };

      void load();
      return undefined;
    },
  });
}

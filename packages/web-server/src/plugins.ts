/**
 * The client plugin set composed into the codexhost Web UI.
 *
 * Order is the scan order the module graph sorts within; it mirrors the DSH web profile with
 * DSH-only product surfaces removed (schedule, goals, workflow runs, jobs, terminals, document
 * preview, plugin manager, Cordis inspector, account, feedback, agent presets, DeepSeek model
 * provider settings).
 */
export const CLIENT_PLUGINS: readonly string[] = [
  "@deepseek-ai/dsh-api-gateway",
  "@deepseek-ai/dsh-client-modules",
  "@deepseek-ai/dsh-client-ui-theme",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-shortcuts",
  "@deepseek-ai/dsh-client-ui-shortcuts",
  "@deepseek-ai/dsh-client-ui-layout",
  "@deepseek-ai/dsh-client-ui-renderer",
  "@deepseek-ai/dsh-client-ui-session",
  "@deepseek-ai/dsh-client-resources",
  "@deepseek-ai/dsh-client-ui-sidebar",
  "@deepseek-ai/dsh-client-ui-sidebar-right",
  "@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-ui-settings-general",
  "@deepseek-ai/dsh-client-ui-conversation",
  "@deepseek-ai/dsh-client-ui-approval",
  "@deepseek-ai/dsh-client-ui-chat",
  "@deepseek-ai/dsh-client-ui-brand-official",
  "@deepseek-ai/dsh-client-ui-attachment",
  "@deepseek-ai/dsh-client-ui-tool",
  "@deepseek-ai/dsh-client-ui-workspace",
  "@deepseek-ai/dsh-client-ui-input-trigger",
  "@deepseek-ai/dsh-client-ui-commands",
  "@deepseek-ai/dsh-client-ui-subagent",
  "@deepseek-ai/dsh-client-ui-model-selection",
  "@deepseek-ai/dsh-client-ui-permission-presets",
  "@deepseek-ai/dsh-client-ui-plan",
  "@deepseek-ai/dsh-client-ui-user-questions",
  "@deepseek-ai/dsh-typert-registry",
  "@deepseek-ai/dsh-client-file-upload",
  "@deepseek-ai/dsh-api-remotes",
  "@deepseek-ai/dsh-api-session-controller",
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-api-workspace-controller",
  "@deepseek-ai/dsh-client-ui-directory-picker-browse",
  "@deepseek-ai/dsh-client-ui-codexhost",
];

/** Configuration globals read by the composed plugins. */
export const CLIENT_GLOBALS: Readonly<Record<string, unknown>> = {
  __DSH_SHORTCUTS_CONFIG__: { stopSequenceMs: 500 },
  __DSH_CONNECTION_RECOVERY__: {
    backoffBaseMs: 500,
    backoffFactor: 2,
    backoffMaxMs: 10000,
    generationReadyWarnMs: 3000,
    generationReadyTimeoutMs: 15000,
  },
};

/**
 * CodexHost client features, browser half: a sidebar entry that opens a page listing the native
 * sessions each installed Harness can hand over (Claude Code, Pi, ...). Importing maps the
 * native session into a Web session; its history is replayed when the conversation opens.
 */
import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type { MainPanelId } from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-workspace/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import { registerHarnessDiscovery } from "./harness-discovery.tsx";
import { registerThreadReferenceDiscovery } from "./thread-reference-discovery.ts";
import { registerThreadReferenceAction } from "./thread-reference-action.ts";
import { desktopScreenshotApi, sentMessageEditApi, turnDiffsApi, voiceApi } from "./api.ts";
import { DesktopScreenshot } from "./desktop-screenshot.ts";
import {
  DesktopScreenshotButton,
  DesktopScreenshotPreview,
  type DesktopScreenshotFace,
  type DesktopScreenshotButtonFace,
} from "./DesktopScreenshot.tsx";
import { VoiceInput } from "./voice-input.ts";
import {
  VoiceActivity,
  VoiceInputButton,
  VoiceNotice,
  VoiceTray,
  type VoiceActivityFace,
  type VoiceFace,
  type VoiceInputFace,
} from "./VoiceInput.tsx";
import { ImportIcon } from "./ImportIcon.tsx";
import { RemoteAccessAction, type RemoteAccessActionFace } from "./RemoteAccessAction.tsx";
import type {} from "@deepseek-ai/dsh-api-session-controller/client";
import { SessionHarnessIcon } from "./SessionHarnessIcon.tsx";
import { HostConnectionStatus } from "./HostConnectionStatus.tsx";
import { SessionOpeningNotice } from "./SessionOpeningNotice.tsx";
import { HostUsageDock } from "./HostUsageDock.tsx";
import type {
  ComposerAttachment,
  ConversationController,
} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-input-trigger/client";
import {
  THREAD_LINK_PATTERN,
  localThreadId,
  threadReferenceOf,
} from "@deepseek-ai/dsh-client-ui-conversation/thread-reference";
import type {} from "@deepseek-ai/dsh-client-ui-chat/client";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import { ConnectDevicesSection } from "./ConnectDevicesSection.tsx";
import { WebExtensionsSection, type WebExtensionsFace } from "./WebExtensionsSection.tsx";
import { watchAuthentication } from "./auth-watch.ts";
import { ensureServiceWorker, resubmitNotifications } from "./notifications.ts";
import { NotificationsRow } from "./NotificationsRow.tsx";
import type {} from "@deepseek-ai/dsh-client-web";
import { PwaInstallRow, type PwaInstallFace } from "./PwaInstallRow.tsx";
import { ImportPage, type ImportPageFace } from "./ImportPage.tsx";
import { HostSettingsSection, type HostSettingsSectionFace } from "./HostSettingsSection.tsx";
import type {} from "@deepseek-ai/dsh-client-ui-theme/client";
import { en, zh, type ImportLocaleKey } from "./locales.ts";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    /** CodexHost import panel copy. */
    codexhostImport: ImportLocaleKey;
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = "codexhostImport";

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = "codexhost-import" as MainPanelId;

/** Services used by the panel. */
export const inject = [
  "slots",
  "locale",
  "layout",
  "uiWorkspace",
  "workspaces",
  "sessions",
  "remote",
  "inputTriggers",
  "theme",
  "connection",
];

/** Console settings pages shown in Web settings, after General. */
const HOST_SETTINGS_PAGES = [
  ["accounts", "settings.accounts", 2],
  ["connections", "settings.connections", 3],
  ["usage-statistics", "settings.usage", 4],
  ["resources", "settings.resources", 5],
  ["updates", "settings.updates", 7],
  ["about", "settings.about", 8],
] as const;

/**
 * Contribute the sidebar entry and its main-column page.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-codexhost: dictionaries");
  const t = ctx.locale.bind(NS);
  const installation = ctx.get("pwaInstall");
  if (installation !== undefined) {
    ctx.slots.inject("settings.general.item", () =>
      ctx.slots.register(
        {
          name: "settings.general.item",
          id: "codexhost.pwa-install",
          order: 90,
          locale: NS,
          inject: (): PwaInstallFace => ({ installation }),
        },
        PwaInstallRow,
      ),
    );
  }
  ctx.provide("chatMessageEditing", sentMessageEditApi);
  ctx.provide("chatTurnDiffs", turnDiffsApi);
  ctx.inject(["conversation", "uiSession"], registerThreadReferenceAction);
  ctx.inject(["conversation"], (scope) => {
    const screenshot = new DesktopScreenshot(desktopScreenshotApi.capture);
    const conversation = scope.conversation as ConversationController;
    const drafts: DesktopScreenshotFace["drafts"] = {
      create: (sessionId, file) => conversation.createDrafts(sessionId as SessionId, [file]),
      release: (created) =>
        conversation.releaseDraftAttachments(created as readonly ComposerAttachment[]),
    };
    scope.effect(() => () => screenshot.close(), "ui-codexhost: release desktop screenshot");
    const screenshotButton: DesktopScreenshotButtonFace = {
      screenshot,
      drafts,
      registerSource: (source) => scope.inputTriggers.registerSource(source),
    };
    scope.slots.inject("conversation.input.right", () =>
      scope.slots.register(
        {
          name: "conversation.input.right",
          id: "codexhost.desktop-screenshot",
          locale: NS,
          inject: (): DesktopScreenshotButtonFace => screenshotButton,
        },
        DesktopScreenshotButton,
      ),
    );
    scope.slots.inject("conversation.input.notice", () =>
      scope.slots.register(
        {
          name: "conversation.input.notice",
          id: "codexhost.desktop-screenshot",
          locale: NS,
          inject: (): DesktopScreenshotFace => ({ screenshot, drafts }),
        },
        DesktopScreenshotPreview,
      ),
    );
    const voice = new VoiceInput(voiceApi.transcribe);
    const tray = new VoiceTray();
    scope.effect(() => () => voice.discard(), "ui-codexhost: release microphone");
    scope.slots.inject("conversation.input.right", () =>
      scope.slots.register(
        {
          name: "conversation.input.right",
          id: "codexhost.voice",
          locale: NS,
          inject: (): VoiceInputFace => ({ voice, blocks: scope.conversation.blocks, tray }),
        },
        VoiceInputButton,
      ),
    );
    scope.slots.inject("conversation.input.activity", () =>
      scope.slots.register(
        {
          name: "conversation.input.activity",
          locale: NS,
          inject: (): VoiceActivityFace => ({ voice, tray }),
        },
        VoiceActivity,
      ),
    );
    scope.slots.inject("conversation.input.notice", () =>
      scope.slots.register(
        {
          name: "conversation.input.notice",
          id: "codexhost.voice",
          locale: NS,
          inject: (): VoiceFace => ({ voice }),
        },
        VoiceNotice,
      ),
    );
    // Mod+Shift+Space starts or finishes; Escape cancels while recording or transcribing.
    scope.effect(() => {
      const onKey = (event: KeyboardEvent) => {
        const { phase } = voice.getSnapshot();
        if (event.key === "Escape" && (phase === "recording" || phase === "transcribing")) {
          event.preventDefault();
          voice.cancel();
        } else if (
          event.code === "Space" &&
          event.shiftKey &&
          (event.metaKey || event.ctrlKey) &&
          !event.altKey
        ) {
          event.preventDefault();
          voice.toggle();
        }
      };
      document.addEventListener("keydown", onKey);
      return () => document.removeEventListener("keydown", onKey);
    }, "ui-codexhost: voice shortcuts");
  });
  ctx.inject(["connection", "modelDirectories", "commandUi"], (scope) =>
    registerHarnessDiscovery(scope),
  );
  ctx.provide("chatLinks", {
    resolve: Object.assign(
      (href: string) => {
        const threadId = localThreadId(href);
        if (threadId === undefined) return;
        const targetId = threadId as SessionId;
        const localTarget = () => {
          const row = ctx.sessions.list.getSnapshot().byId[targetId];
          return row === undefined ? undefined : threadReferenceOf(row);
        };
        if (localTarget() === undefined) return;
        const destination = new URL(window.location.href);
        destination.searchParams.set("session", targetId);
        return {
          href: destination.href,
          open: () => {
            if (localTarget() !== undefined) ctx.uiWorkspace.openSession(targetId);
          },
        };
      },
      {
        autoLinkPattern: THREAD_LINK_PATTERN,
        subscribe: (listener: () => void) => ctx.sessions.list.subscribe(listener),
      },
    ),
  });
  registerThreadReferenceDiscovery(ctx);
  const face = {
    openSession: (sessionId: string) => {
      ctx.uiWorkspace.openSession(sessionId as SessionId);
    },
  };
  ctx.slots.inject("main", () =>
    ctx.slots.register(
      {
        name: "main",
        key: PANEL_ID,
        locale: NS,
        inject: (): ImportPageFace => ({
          openSession: async (threadId, signal) => {
            const id = threadId as SessionId;
            if (ctx.sessions.list.getSnapshot().byId[id] === undefined)
              await ctx.sessions.loadSummary(id);
            signal.throwIfAborted();
            if (ctx.sessions.list.getSnapshot().byId[id] === undefined)
              throw new Error(t("catalogPending"));
            face.openSession(threadId);
          },
        }),
      },
      ImportPage,
    ),
  );
  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      {
        name: "sidebar.panellist",
        id: PANEL_ID,
        order: 10,
        label: () => t("panel"),
        locale: NS,
      },
      ImportIcon,
    ),
  );
  ctx.inject(["settingsNavigation"], (scope) => {
    scope.slots.inject("sidebar.primary.action", () =>
      scope.slots.register(
        {
          name: "sidebar.primary.action",
          id: "codexhost-remote-access",
          locale: NS,
          inject: (): RemoteAccessActionFace => ({
            openSection: (id) => scope.settingsNavigation.openSection(id),
          }),
        },
        RemoteAccessAction,
      ),
    );
  });
  ctx.slots.inject("settings.general.item", () =>
    ctx.slots.register(
      {
        name: "settings.general.item",
        id: "codexhost.notifications",
        order: 5,
        locale: NS,
      },
      NotificationsRow,
    ),
  );

  const locale: HostSettingsSectionFace["locale"] = {
    get: () => ctx.locale.getLocale().active,
    subscribe: (listener) => ctx.locale.subscribe(listener),
  };
  const colorScheme: HostSettingsSectionFace["colorScheme"] = {
    get: () => ctx.theme.getTheme().active.colorScheme,
    subscribe: (listener) => ctx.on("theme/change", listener),
  };
  // Local management entries stay visible to remote users with access guidance.
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "codexhost-ui-extensions",
        order: 6,
        label: () => t("settings.extensions"),
        locale: NS,
        inject: (): WebExtensionsFace => ({ resolveText: (text) => ctx.locale.resolveText(text) }),
      },
      WebExtensionsSection,
    ),
  );
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "codexhost-connect-devices",
        order: 1,
        label: () => t("remoteAccess"),
        locale: NS,
      },
      ConnectDevicesSection,
    ),
  );
  HOST_SETTINGS_PAGES.forEach(([pageId, label, order]) => {
    ctx.slots.inject("settings.section", () =>
      ctx.slots.register(
        {
          name: "settings.section",
          id: `codexhost-${pageId}`,
          order,
          label: () => t(label),
          locale: NS,
          inject: (): HostSettingsSectionFace => ({ pageId, locale, colorScheme }),
        },
        HostSettingsSection,
      ),
    );
  });

  for (const name of [
    "sidebar.session.row.identity",
    "workspace.recent.shortcut.identity",
  ] as const) {
    ctx.slots.inject(name, () =>
      ctx.slots.register(
        {
          name,
          id: "codexhost.harness",
          inject: () => ({ list: ctx.sessions.list }),
        },
        SessionHarnessIcon,
      ),
    );
  }

  ctx.slots.inject("conversation.header.notice", () =>
    ctx.slots.register(
      {
        name: "conversation.header.notice",
        id: "codexhost.connection",
        locale: NS,
        inject: () => ({
          list: ctx.sessions.list,
          connection: ctx.get("connection") as ConnectionHandle,
        }),
      },
      HostConnectionStatus,
    ),
  );
  ctx.slots.inject("conversation.header.notice", () =>
    ctx.slots.register(
      {
        name: "conversation.header.notice",
        id: "codexhost.session-opening",
        locale: NS,
        inject: () => ({ navigation: ctx.uiWorkspace }),
      },
      SessionOpeningNotice,
    ),
  );
  ctx.slots.inject("conversation.composer.dock", () =>
    ctx.slots.register(
      {
        name: "conversation.composer.dock",
        id: "codexhost.usage",
        order: 2,
        locale: NS,
      },
      HostUsageDock,
    ),
  );

  ctx.effect(
    () =>
      ctx.remote.$on("codexhost/session-bound", (draftId, threadId) => {
        if (
          (ctx.sessions.list.getSnapshot().byId[draftId as SessionId]?.retainedBy.mainView ?? 0) > 0
        )
          ctx.uiWorkspace.openSession(threadId as SessionId);
      }),
    "ui-codexhost: canonical CH identity",
  );

  // Deep links (`?session=<id>`, used by notification clicks) and service-worker messages.
  ensureServiceWorker();
  resubmitNotifications();
  ctx.effect(
    () => watchAuthentication((ctx.get("connection") as ConnectionHandle).state),
    "ui-codexhost: enter sign-in when the token is revoked",
  );
  const openFromUrl = (): void => {
    const url = new URL(window.location.href);
    const sessionId = url.searchParams.get("session");
    if (sessionId === null) return;
    url.searchParams.delete("session");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    face.openSession(sessionId);
  };
  openFromUrl();
  const onMessage = (event: MessageEvent): void => {
    const data = event.data as { type?: string; sessionId?: string } | undefined;
    if (data?.type === "codexhost/open-session" && typeof data.sessionId === "string")
      face.openSession(data.sessionId);
  };
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", onMessage);
    ctx.effect(
      () => () => {
        navigator.serviceWorker.removeEventListener("message", onMessage);
      },
      "ui-codexhost: service worker messages",
    );
  }
}

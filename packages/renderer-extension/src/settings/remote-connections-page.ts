import type { RuntimeStatus } from "@codexhost/shared-contracts";
import type { RemoteConnectionsControl } from "../remote-connections-control.js";
import type { RendererSettingsPageDefinition } from "./core.js";
import { createRendererSettingsIcon } from "./icons.js";
import type { RendererSettingsMessages } from "./localization.js";
import {
  remoteBusy,
  remoteElement,
  remoteErrorMessage,
  remoteInstallVersion,
  remoteMaintenanceTarget,
  remoteVersionIssue,
  renderRemoteCard,
  type RemoteCardAction,
  type RemoteConnectionRow,
  type RemoteText,
} from "./remote-connections-card.js";
import { localizeRemoteFailure } from "./remote-failure-messages.js";
import {
  openRemoteConnectionEditor,
  openRemoteConnectionRemoval,
} from "./remote-connections-dialogs.js";

const POLL_INTERVAL_MS = 5_000;
const SUCCESS_NOTICE_MS = 6_000;
/** A failed SSH inspection is retried, but not on every poll: repeated logins can trip host bans. */
const INSPECT_RETRY_MS = 60_000;
/** How long a service that was updating may be unreachable before that counts as a problem. */
const RESTART_GRACE_MS = 90_000;
const CONNECT_REQUEST_WAIT_MS = 3_000;

export function createRemoteConnectionsPage(
  messages: RendererSettingsMessages,
  getControl: () => RemoteConnectionsControl | null,
): RendererSettingsPageDefinition {
  const zh = messages.locale === "zh-CN";
  const t: RemoteText = (cn, en) => (zh ? cn : en);
  return Object.freeze<RendererSettingsPageDefinition>({
    id: "remote-connections",
    label: messages.pageLabels["remote-connections"],
    icon: "gateway",
    mount({ content, signal }) {
      const document = content.ownerDocument;
      const el = <K extends keyof HTMLElementTagNameMap>(
        tag: K,
        className = "",
        text = "",
      ): HTMLElementTagNameMap[K] => remoteElement(document, tag, className, text);
      const emptyPanel = (title: string, detail: string): HTMLElement => {
        const panel = el("div", "settings-remote__empty");
        const copy = el("div");
        copy.append(el("strong", "", title), el("span", "", detail));
        panel.append(copy);
        return panel;
      };

      const root = el("div", "settings-remote");
      const header = el("div", "settings-remote__header");
      const headerCopy = el("div");
      const localVersion = el("p", "settings-remote__meta");
      headerCopy.append(
        el("h1", "settings-section-label", messages.pageLabels["remote-connections"]),
        el(
          "p",
          "settings-page-description",
          t(
            "通过 SSH 连接你的 Mac 或 Linux 电脑。连接配置与 Codex 共用。",
            "Connect to a Mac or Linux computer over SSH. Connection settings are shared with Codex.",
          ),
        ),
        localVersion,
      );
      header.append(headerCopy);
      root.append(header);
      content.append(root);

      const availableControl = getControl();
      if (!availableControl) {
        root.append(
          emptyPanel(
            t("此窗口无法管理 SSH 连接", "SSH connections are unavailable in this window"),
            t("请在 Codex 桌面程序中管理 SSH 连接。", "Manage SSH connections in Codex Desktop."),
          ),
        );
        return;
      }
      const control = availableControl;

      const toolbar = el("div", "settings-remote__toolbar");
      const refreshButton = el("button", "settings-icon-button settings-remote__refresh");
      refreshButton.type = "button";
      refreshButton.title = t("刷新", "Refresh");
      refreshButton.setAttribute("aria-label", t("刷新", "Refresh"));
      refreshButton.append(createRendererSettingsIcon("refresh", 16));
      const addButton = el("button", "settings-command-button");
      addButton.type = "button";
      addButton.append(createRendererSettingsIcon("add", 14), t("添加连接", "Add connection"));
      toolbar.append(refreshButton, addButton);
      header.append(toolbar);

      const banner = el("div", "settings-remote__banner");
      banner.setAttribute("role", "alert");
      banner.hidden = true;
      const bannerText = el("span");
      const retry = el(
        "button",
        "settings-command-button settings-command-button--secondary",
        t("重试", "Retry"),
      );
      retry.type = "button";
      banner.append(bannerText, retry);
      const placeholder = el("div", "settings-remote__placeholder");
      const list = el("div", "settings-remote__list");
      root.append(banner, placeholder, list);

      let local: RuntimeStatus | null = null;
      let localLoaded = false;
      let loaded = false;
      let loadError: string | null = null;
      let order: string[] = [];
      let polling = false;
      const rows = new Map<string, RemoteConnectionRow>();
      const cards = new Map<string, { element: HTMLElement; signature: string }>();
      const installations = new Map<string, "installed" | "not-installed" | "unknown">();
      const probeTokens = new Map<string, number>();
      const inspectFailures = new Map<string, number>();
      const restarting = new Map<string, number>();

      const focusedElement = (): HTMLElement | null => {
        const active = (root.getRootNode() as Document | ShadowRoot).activeElement;
        return active instanceof HTMLElement ? active : null;
      };

      function renderPlaceholder(): void {
        if (!loaded) {
          const loading = el("p", "settings-remote__loading");
          loading.append(
            el("span", "settings-remote-spinner"),
            t("正在读取连接…", "Loading connections…"),
          );
          placeholder.replaceChildren(...(loadError ? [] : [loading]));
        } else if (!order.length) {
          const empty = emptyPanel(
            t("还没有 SSH 连接", "No SSH connections yet"),
            t(
              "添加一台 Mac 或 Linux 电脑，在上面运行会话。",
              "Add a Mac or Linux computer to run conversations on it.",
            ),
          );
          const add = el(
            "button",
            "settings-command-button settings-command-button--secondary",
            t("添加连接", "Add connection"),
          );
          add.type = "button";
          add.addEventListener("click", () => edit(null));
          empty.append(add);
          placeholder.replaceChildren(empty);
        } else placeholder.replaceChildren();
      }

      /** Replaces only the cards whose content changed, so focus survives background polling. */
      function render(): void {
        if (signal.aborted) return;
        localVersion.textContent = localLoaded
          ? `${t("本机 codexhost", "Local codexhost")} ${local?.runningVersion ?? t("版本暂时无法读取", "version is temporarily unavailable")}`
          : "";
        banner.hidden = !loadError;
        bannerText.textContent = loadError
          ? `${t("读取连接失败", "Could not load connections")}: ${localizeRemoteFailure(loadError, t)}`
          : "";
        renderPlaceholder();
        for (const [hostId, card] of cards) {
          if (rows.has(hostId)) continue;
          card.element.remove();
          cards.delete(hostId);
        }
        const active = focusedElement();
        order.forEach((hostId, index) => {
          const row = rows.get(hostId);
          if (!row) return;
          const signature = JSON.stringify([row, local]);
          let card = cards.get(hostId);
          if (card?.signature !== signature) {
            const element = renderRemoteCard(document, row, local, t, (action) =>
              handle(row, action),
            );
            const focusedAction =
              active && card?.element.contains(active) ? active.dataset.action : undefined;
            if (card) card.element.replaceWith(element);
            card = { element, signature };
            cards.set(hostId, card);
            if (focusedAction) focusAction(element, focusedAction);
          }
          if (list.children[index] !== card.element)
            list.insertBefore(card.element, list.children[index] ?? null);
        });
      }

      function focusAction(card: HTMLElement, action: string): void {
        const target =
          card.querySelector<HTMLButtonElement>(`[data-action="${action}"]:not(:disabled)`) ??
          card.querySelector<HTMLButtonElement>("button:not(:disabled)");
        target?.focus();
      }

      async function probe(row: RemoteConnectionRow): Promise<void> {
        const { hostId } = row.connection;
        const token = (probeTokens.get(hostId) ?? 0) + 1;
        probeTokens.set(hostId, token);
        const state = await control.ssh
          .state(hostId, signal)
          .catch((error: unknown) => ({ state: "unknown", error: remoteErrorMessage(error) }));
        let remote: RuntimeStatus | null = null;
        let remoteIssue: RemoteConnectionRow["remoteIssue"] = null;
        if (state.state === "connected")
          remote = await control.runtime(hostId).catch((error: unknown) => {
            remoteIssue = remoteVersionIssue(error);
            return null;
          });
        // An update restarts the service, so it drops off for a moment. Keep showing the
        // update as in progress instead of offering troubleshooting for an expected gap.
        let expectedGap = false;
        if (remote && remoteBusy(remote)) restarting.set(hostId, Date.now() + RESTART_GRACE_MS);
        else if (remote || (restarting.get(hostId) ?? 0) <= Date.now()) restarting.delete(hostId);
        else if (row.remote) {
          expectedGap = true;
          remote = { ...row.remote, update: { ...row.remote.update, phase: "restarting" } };
          remoteIssue = null;
        }
        if (remote) installations.set(hostId, "installed");
        else if (
          !installations.has(hostId) &&
          Date.now() - (inspectFailures.get(hostId) ?? -INSPECT_RETRY_MS) >= INSPECT_RETRY_MS
        ) {
          const inspected = await control.setup(row.connection, "inspect").catch(() => null);
          if (inspected) installations.set(hostId, inspected.state);
          else inspectFailures.set(hostId, Date.now());
        }
        // A newer probe of the same host owns the row; drop this answer.
        if (signal.aborted || rows.get(hostId) !== row || probeTokens.get(hostId) !== token) return;
        row.probing = false;
        row.state = expectedGap ? "connecting" : state.state;
        row.stateError = expectedGap ? null : state.error;
        row.remote = remote;
        row.remoteIssue = remoteIssue;
        row.installation = installations.get(hostId) ?? "unknown";
        render();
      }

      /**
       * Reloads the list and probes each host. It resolves once the list is shown and, when
       * `actingHostId` is given, that host has answered; other hosts fill in on their own, so
       * one unreachable computer never holds up a dialog or another computer's action.
       */
      async function refresh(
        actingHostId?: string,
        wait: "all" | "acting" = "acting",
      ): Promise<void> {
        if (signal.aborted) return;
        const localTask = control
          .runtime("local")
          .catch(() => null)
          .then((status) => {
            if (signal.aborted) return;
            local = status;
            localLoaded = true;
            render();
          });
        let connections;
        try {
          connections = await control.ssh.list(signal);
        } catch (error) {
          if (signal.aborted) return;
          loadError = remoteErrorMessage(error);
          render();
          return;
        }
        if (signal.aborted) return;
        loadError = null;
        loaded = true;
        order = connections.map((connection) => connection.hostId);
        for (const connection of connections) {
          const row = rows.get(connection.hostId);
          if (row) row.connection = connection;
          else
            rows.set(connection.hostId, {
              connection,
              probing: true,
              state: null,
              stateError: null,
              remote: null,
              remoteIssue: null,
              installation: null,
              pending: null,
              notice: null,
            });
        }
        for (const hostId of [...rows.keys()]) {
          if (order.includes(hostId)) continue;
          rows.delete(hostId);
          installations.delete(hostId);
          probeTokens.delete(hostId);
          inspectFailures.delete(hostId);
          restarting.delete(hostId);
        }
        render();
        const probes = [...rows.values()]
          .filter((row) => !row.pending || row.connection.hostId === actingHostId)
          .map((row) => ({ hostId: row.connection.hostId, done: probe(row) }));
        const awaited = wait === "all" ? probes : probes.filter((p) => p.hostId === actingHostId);
        await Promise.all([localTask, ...awaited.map((p) => p.done)]);
      }

      /** Runs one action against one host; other hosts stay usable meanwhile. */
      async function act(
        row: RemoteConnectionRow,
        action: RemoteCardAction,
        label: string,
        /** A resolved string is shown as the success message. */
        operation: () => Promise<unknown>,
      ): Promise<void> {
        const { hostId } = row.connection;
        row.pending = label;
        row.notice = null;
        render();
        try {
          const done = await operation();
          await refresh(hostId);
          if (typeof done === "string") {
            const notice = { tone: "success" as const, text: done };
            row.notice = notice;
            setTimeout(() => {
              if (row.notice !== notice) return;
              row.notice = null;
              render();
            }, SUCCESS_NOTICE_MS);
          }
        } catch (error) {
          row.notice = { tone: "danger", text: remoteErrorMessage(error) };
          // A failed action can still have changed the remote (installed but not started, for
          // example), so look again instead of trusting what was known before.
          installations.delete(hostId);
          inspectFailures.delete(hostId);
          void refresh(hostId);
        } finally {
          row.pending = null;
          if (!signal.aborted) {
            render();
            // Disabling the buttons during the action dropped focus; hand it back.
            const card = cards.get(hostId)?.element;
            if (card && !focusedElement()) focusAction(card, action);
          }
        }
      }

      function edit(previous: RemoteConnectionRow["connection"] | null): void {
        openRemoteConnectionEditor({
          container: root,
          signal,
          t,
          previous,
          async save(draft) {
            await control.ssh.save(draft, previous, signal);
            await refresh();
          },
        });
      }

      function handle(row: RemoteConnectionRow, action: RemoteCardAction): void {
        if (row.pending) return;
        const { connection } = row;
        const { hostId } = connection;
        /**
         * Asks Codex to connect or disconnect. Codex answers only after its own attempt, which
         * can outlast the request for an unreachable computer; the connection state shown on
         * the card reports the outcome, so a slow answer is not an error here.
         */
        const setConnected = async (enabled: boolean): Promise<void> => {
          const request = control.ssh.connect(hostId, enabled, signal);
          request.catch(() => undefined);
          await Promise.race([
            request,
            new Promise((resolve) => setTimeout(resolve, CONNECT_REQUEST_WAIT_MS)),
          ]);
        };
        const reconnect = async (): Promise<void> => {
          installations.delete(hostId);
          inspectFailures.delete(hostId);
          await setConnected(true);
        };
        switch (action) {
          case "edit":
            edit(connection);
            break;
          case "remove":
            openRemoteConnectionRemoval({
              container: root,
              signal,
              t,
              connection,
              async remove() {
                await control.ssh.remove(connection, signal);
                await refresh();
              },
            });
            break;
          case "toggle":
            void act(
              row,
              action,
              connection.autoConnect
                ? t("正在断开…", "Disconnecting…")
                : t("正在连接…", "Connecting…"),
              () => setConnected(!connection.autoConnect),
            );
            break;
          case "reconnect":
            void act(row, action, t("正在重新连接…", "Reconnecting…"), async () => {
              await setConnected(false);
              await setConnected(true);
            });
            break;
          case "recheck":
            void act(row, action, t("正在重新检测…", "Checking again…"), async () => {
              installations.delete(hostId);
              inspectFailures.delete(hostId);
            });
            break;
          case "install": {
            const version = remoteInstallVersion(local);
            if (!version) break;
            void act(
              row,
              action,
              t("正在安装远程服务，请稍候…", "Installing remote service, please wait…"),
              async () => {
                await control.setup(connection, "install", version);
                await reconnect();
                return t("远程服务已安装，正在连接", "Remote service installed; connecting");
              },
            );
            break;
          }
          case "upgrade": {
            const version = remoteInstallVersion(local);
            if (!version) break;
            void act(
              row,
              action,
              t("正在更新远程服务，请稍候…", "Updating remote service, please wait…"),
              async () => {
                await control.setup(connection, "update", version);
                await reconnect();
                return t("远程服务已更新，正在连接", "Remote service updated; connecting");
              },
            );
            break;
          }
          case "repair":
            void act(
              row,
              action,
              t("正在重新配置远程服务…", "Reconfiguring remote service…"),
              async () => {
                await control.setup(connection, "repair");
                await reconnect();
                return t("远程服务已修复，正在连接", "Remote service repaired; connecting");
              },
            );
            break;
          case "update": {
            const target = row.remote ? remoteMaintenanceTarget(local, row.remote) : null;
            if (!target) break;
            const restart = target === row.remote?.installedVersion;
            void act(
              row,
              action,
              restart
                ? t("正在重启远程服务…", "Restarting remote service…")
                : t("正在提交更新…", "Starting update…"),
              async () => {
                await control.update(hostId, target);
                await setConnected(true);
              },
            );
            break;
          }
        }
      }

      const reload = (): void => {
        if (refreshButton.getAttribute("aria-busy") === "true") return;
        refreshButton.setAttribute("aria-busy", "true");
        installations.clear();
        inspectFailures.clear();
        void refresh(undefined, "all").finally(() => refreshButton.removeAttribute("aria-busy"));
      };
      refreshButton.addEventListener("click", reload);
      retry.addEventListener("click", reload);
      addButton.addEventListener("click", () => edit(null));

      render();
      void refresh();
      const timer = setInterval(() => {
        if (polling) return;
        polling = true;
        void refresh(undefined, "all").finally(() => {
          polling = false;
        });
      }, POLL_INTERVAL_MS);
      return () => clearInterval(timer);
    },
  });
}

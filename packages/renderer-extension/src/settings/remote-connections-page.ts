import type { RuntimeStatus } from "@codexhost/shared-contracts";
import type { CodexSshConnection } from "../codex-ssh-adapter.js";
import {
  remoteUpdateTarget,
  type RemoteConnectionsControl,
} from "../remote-connections-control.js";
import type { RendererSettingsPageDefinition } from "./core.js";
import type { RendererSettingsMessages } from "./localization.js";

export function createRemoteConnectionsPage(
  messages: RendererSettingsMessages,
  getControl: () => RemoteConnectionsControl | null,
): RendererSettingsPageDefinition {
  const zh = messages.locale === "zh-CN";
  const t = (cn: string, en: string): string => (zh ? cn : en);
  return Object.freeze<RendererSettingsPageDefinition>({
    id: "remote-connections",
    label: messages.pageLabels["remote-connections"],
    icon: "gateway",
    mount({ content, signal }) {
      const document = content.ownerDocument;
      const availableControl = getControl();
      const element = <K extends keyof HTMLElementTagNameMap>(
        tag: K,
        text = "",
        className = "",
      ): HTMLElementTagNameMap[K] => {
        const result = document.createElement(tag);
        result.textContent = text;
        result.className = className;
        return result;
      };
      const root = element("div", "", "settings-remote");
      const toolbar = element("div", "", "settings-remote__actions");
      const status = element("p");
      status.setAttribute("role", "status");
      const localVersion = element("p", t("本机版本：正在读取…", "Local version: loading…"));
      const list = element("div", "", "settings-remote__list");
      const editor = element("div");
      root.append(
        element("h2", t("远程连接", "Remote connections")),
        element(
          "p",
          t(
            "通过 SSH 连接你的 Mac 或 Linux 电脑。连接配置与 Codex 共用。",
            "Connect to a Mac or Linux computer over SSH. Connection settings are shared with Codex.",
          ),
        ),
        toolbar,
        element(
          "p",
          t(
            "更新、重启或修复会立即执行，可能中断正在进行的会话。",
            "Updates, restarts and repairs run immediately and may interrupt active conversations.",
          ),
        ),
        localVersion,
        status,
        editor,
        list,
      );
      content.append(root);
      if (!availableControl) {
        status.textContent = t(
          "请在 Codex 桌面程序中管理 SSH 连接。",
          "Manage SSH connections in Codex Desktop.",
        );
        localVersion.hidden = true;
        return;
      }
      const control = availableControl;
      let local: RuntimeStatus | null = null;
      let busy = false;
      let refreshing = false;
      let editing = false;
      let generation = 0;
      const button = (label: string, action: () => Promise<void> | void): HTMLButtonElement => {
        const result = element(
          "button",
          label,
          "settings-command-button settings-command-button--secondary",
        );
        result.type = "button";
        result.addEventListener("click", () => {
          if (busy) return;
          busy = true;
          result.disabled = true;
          status.textContent = "";
          void Promise.resolve()
            .then(action)
            .catch((error: unknown) => {
              if (!signal.aborted)
                status.textContent = error instanceof Error ? error.message : String(error);
            })
            .finally(() => {
              busy = false;
              result.disabled = false;
            });
        });
        return result;
      };
      const installations = new Map<string, "installed" | "not-installed" | "unknown">();
      function edit(previous: CodexSshConnection | null): void {
        editing = true;
        editor.replaceChildren();
        const form = element("form", "", "settings-remote__editor");
        form.append(
          element(
            "h3",
            previous ? t("编辑连接", "Edit connection") : t("添加 SSH 连接", "Add SSH connection"),
          ),
        );
        const field = (label: string, value: string, placeholder = ""): HTMLInputElement => {
          const wrapper = element("label", label);
          const input = element("input");
          input.value = value;
          input.placeholder = placeholder;
          wrapper.append(input);
          form.append(wrapper);
          return input;
        };
        const name = field(t("名称", "Name"), previous?.displayName ?? "");
        name.required = true;
        const hostname = field(
          t("SSH 地址", "SSH address"),
          previous?.sshHost ?? "",
          "user@hostname / SSH alias",
        );
        hostname.required = true;
        const port = field(
          t("端口（可选）", "Port (optional)"),
          previous?.sshPort?.toString() ?? "",
          "22",
        );
        port.type = "number";
        port.min = "1";
        port.max = "65535";
        const identity = field(
          t("私钥路径（可选）", "Identity file (optional)"),
          previous?.identity ?? "",
          "~/.ssh/id_ed25519",
        );
        if (previous?.source === "discovered") {
          hostname.disabled = port.disabled = identity.disabled = true;
          form.append(
            element(
              "p",
              t(
                "此连接来自 SSH 配置，详细配置请在原生设置中编辑。",
                "This connection comes from SSH config. Edit its details in native settings.",
              ),
            ),
          );
        }
        const actions = element("div", "", "settings-remote__actions");
        const save = element("button", t("保存", "Save"), "settings-command-button");
        save.type = "submit";
        const cancel = button(t("取消", "Cancel"), () => {
          editing = false;
          editor.replaceChildren();
        });
        actions.append(save, cancel);
        form.append(actions);
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          if (busy || !form.reportValidity()) return;
          busy = true;
          save.disabled = true;
          status.textContent = "";
          void control.ssh
            .save(
              {
                displayName: name.value,
                hostname: hostname.value,
                sshPort: port.value ? Number(port.value) : null,
                identity: identity.value.trim() || null,
              },
              previous,
              signal,
            )
            .then(async () => {
              if (signal.aborted) return;
              editing = false;
              editor.replaceChildren();
              await refresh();
            })
            .catch((error: unknown) => {
              if (!signal.aborted) status.textContent = String(error);
            })
            .finally(() => {
              busy = false;
              save.disabled = false;
            });
        });
        editor.append(form);
        name.focus();
      }
      function versionPanel(remote: RuntimeStatus): HTMLElement {
        const panel = element("div", "", "settings-remote__versions");
        panel.append(
          element("span", `${t("已安装", "Installed")}: ${remote.installedVersion ?? "—"}`),
          element("span", `${t("运行中", "Running")}: ${remote.runningVersion ?? "—"}`),
        );
        if (remote.restartRequired)
          panel.append(
            element(
              "strong",
              t("需要重启以使用已安装的版本", "Restart needed to use the installed version"),
            ),
          );
        if (
          remoteUpdateTarget(local, { ...remote, update: { ...remote.update, phase: "idle" } }) &&
          remote.installedVersion !== local?.runningVersion
        )
          panel.append(
            element("strong", t("远程服务有更新可用", "Remote service update available")),
          );
        else if (remote.installedVersion === local?.runningVersion && !remote.restartRequired)
          panel.append(element("span", t("版本已匹配", "Versions match")));
        const phases: Record<RuntimeStatus["update"]["phase"], string> = {
          idle: "",
          installing: t("正在更新远程服务…", "Updating remote service…"),
          restarting: t("正在重启，请稍候重连…", "Restarting; reconnecting shortly…"),
          succeeded: t("远程服务已更新", "Remote service updated"),
          failed: t("更新失败，可以重试", "Update failed; you can retry"),
        };
        if (phases[remote.update.phase]) panel.append(element("span", phases[remote.update.phase]));
        if (remote.update.error) panel.append(element("p", remote.update.error));
        if (
          local?.runningVersion &&
          remote.installedVersion &&
          local.runningVersion !== remote.installedVersion &&
          !remoteUpdateTarget(local, { ...remote, update: { ...remote.update, phase: "idle" } })
        ) {
          panel.append(
            element(
              "p",
              t(
                "版本不同，请先检查本机更新；不会自动降低远程版本。",
                "Versions differ. Check for a local update; the remote version will not be downgraded.",
              ),
            ),
          );
        }
        return panel;
      }
      async function refresh(): Promise<void> {
        if (refreshing || signal.aborted) return;
        refreshing = true;
        const current = ++generation;
        try {
          const connections = await control.ssh.list(signal);
          local = await control.runtime("local").catch(() => null);
          const rows = await Promise.all(
            connections.map(async (connection) => {
              const state = await control.ssh
                .state(connection.hostId, signal)
                .catch((error: unknown) => ({ state: "unknown", error: String(error) }));
              let remote: RuntimeStatus | null = null;
              if (state.state === "connected")
                remote = await control.runtime(connection.hostId).catch(() => null);
              if (remote) installations.set(connection.hostId, "installed");
              else if (!installations.has(connection.hostId)) {
                const inspected = await control.setup(connection, "inspect").catch(() => null);
                installations.set(connection.hostId, inspected?.state ?? "unknown");
              }
              return { connection, state, remote };
            }),
          );
          if (signal.aborted || current !== generation) return;
          localVersion.textContent = `${t("本机 codexhost", "Local codexhost")}: ${local?.runningVersion ?? t("暂时无法读取，点击刷新重试", "Temporarily unavailable; refresh to retry")}`;
          const cards = rows.map(({ connection, state, remote }) => {
            const card = element("section", "", "settings-remote__card");
            const states: Record<string, string> = {
              connected: t("已连接", "Connected"),
              connecting: t("连接中", "Connecting"),
              disconnected: t("未连接", "Disconnected"),
              error: t("连接失败", "Connection failed"),
            };
            card.append(
              element("h3", connection.displayName),
              element(
                "p",
                `${connection.sshAlias ?? connection.sshHost}${connection.sshPort ? ` · ${connection.sshPort}` : ""}`,
              ),
              element("p", states[state.state] ?? state.state),
            );
            if (state.error) card.append(element("p", state.error));
            const installation = installations.get(connection.hostId);
            if (installation === "not-installed")
              card.append(element("p", t("需要安装远程服务", "Remote service needs installation")));
            if (remote) card.append(versionPanel(remote));
            else if (installation !== "not-installed")
              card.append(
                element(
                  "p",
                  t(
                    "暂时无法读取远程版本，可刷新或重新连接后再试。",
                    "Remote version information is temporarily unavailable. Refresh or reconnect to retry.",
                  ),
                ),
              );
            const actions = element("div", "", "settings-remote__actions");
            if (installation !== "not-installed")
              actions.append(
                button(
                  connection.autoConnect ? t("断开", "Disconnect") : t("连接", "Connect"),
                  async () => {
                    await control.ssh.connect(connection.hostId, !connection.autoConnect, signal);
                    await refresh();
                  },
                ),
              );
            actions.append(button(t("编辑", "Edit"), () => edit(connection)));
            const remove = button(t("移除", "Remove"), () => {
              // A second deliberate click confirms removing the saved native connection.
              editing = true;
              const confirmation = element(
                "div",
                t(
                  "移除连接不会删除远程文件或会话。",
                  "Removing a connection does not delete remote files or chats.",
                ),
              );
              confirmation.append(
                button(t("确认移除", "Confirm removal"), async () => {
                  await control.ssh.remove(connection, signal);
                  await refresh();
                }),
              );
              confirmation.append(
                button(t("取消", "Cancel"), async () => {
                  editing = false;
                  await refresh();
                }),
              );
              remove.replaceWith(confirmation);
            });
            actions.append(remove);
            if (installation === "not-installed") {
              const version = local?.runningVersion;
              const install = button(t("安装并连接", "Install and connect"), async () => {
                if (!version || !/^\d+\.\d+\.\d+$/u.test(version))
                  throw new Error(
                    t(
                      "请使用本机正式发布版本安装远程服务",
                      "Use a published local release to install the remote service",
                    ),
                  );
                status.textContent = t(
                  "正在安装远程服务，请稍候…",
                  "Installing remote service, please wait…",
                );
                await control.setup(connection, "install", version);
                installations.delete(connection.hostId);
                await control.ssh.connect(connection.hostId, true, signal);
                await refresh();
                status.textContent = t(
                  "远程服务已安装，正在连接",
                  "Remote service installed; connecting",
                );
              });
              install.disabled = !version || !/^\d+\.\d+\.\d+$/u.test(version);
              actions.prepend(install);
              if (install.disabled)
                card.append(
                  element(
                    "p",
                    t(
                      "本机版本不可用于安装，请使用正式发布版本。",
                      "Install from a published local release.",
                    ),
                  ),
                );
            }
            if (installation !== "not-installed") {
              const repair = button(t("修复远程服务", "Repair remote service"), async () => {
                status.textContent = t("正在重新配置远程服务…", "Reconfiguring remote service…");
                await control.setup(connection, "repair");
                installations.delete(connection.hostId);
                await control.ssh.connect(connection.hostId, true, signal);
                await refresh();
                status.textContent = t(
                  "远程服务已修复，正在连接",
                  "Remote service repaired; connecting",
                );
              });
              repair.disabled =
                !!remote && ["installing", "restarting"].includes(remote.update.phase);
              actions.append(repair);
            }
            if (!remote)
              actions.append(
                button(t("重新检测", "Check again"), async () => {
                  installations.delete(connection.hostId);
                  await refresh();
                }),
              );

            if (remote?.updateSupported) {
              const target =
                remoteUpdateTarget(local, {
                  ...remote,
                  update: { ...remote.update, phase: "idle" },
                }) ?? (remote.restartRequired ? remote.installedVersion : null);
              if (target) {
                const update = button(
                  target === remote.installedVersion
                    ? t("重启并连接", "Restart and connect")
                    : t("更新到本机版本", "Match local version"),
                  async () => {
                    await control.update(connection.hostId, target);
                    await control.ssh.connect(connection.hostId, true, signal);
                    await refresh();
                  },
                );
                update.disabled = ["installing", "restarting"].includes(remote.update.phase);
                actions.append(update);
              }
            }
            card.append(actions);
            return card;
          });
          list.replaceChildren(...cards);
          if (!cards.length)
            list.append(
              element(
                "p",
                t(
                  "还没有 SSH 连接，添加一个开始使用。",
                  "No SSH connections yet. Add one to get started.",
                ),
              ),
            );
        } catch (error) {
          if (!signal.aborted)
            status.textContent = `${t("读取连接失败", "Could not load connections")}: ${String(error)}`;
        } finally {
          refreshing = false;
        }
      }
      toolbar.append(
        button(t("添加连接", "Add connection"), () => edit(null)),
        button(t("刷新", "Refresh"), async () => {
          installations.clear();
          await refresh();
        }),
      );
      void refresh();
      const timer = setInterval(() => {
        if (!busy && !editing && !list.matches(":focus-within")) void refresh();
      }, 5_000);
      return () => {
        generation++;
        clearInterval(timer);
      };
    },
  });
}

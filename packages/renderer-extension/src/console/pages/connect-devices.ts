import { encode } from "uqr";
import {
  webAccessStateSchema,
  webServeResultSchema,
  type WebAccessState,
} from "@codexhost/shared-contracts";
import type { RendererSettingsPageDefinition } from "../../settings/core.js";
import { consolePost } from "../api.js";
import { confirmAction } from "../confirm.js";
import { button, h } from "../dom.js";

/** A local view of Web's connection state. All mutations use Web's existing RPCs. */
export function createConnectDevicesPage(locale: string): RendererSettingsPageDefinition {
  const chinese = locale.startsWith("zh");
  const t = (zh: string, en: string): string => (chinese ? zh : en);
  const kindLabels = {
    public: t("公开地址", "Public address"),
    relay: t("中转", "Relay"),
    "tailscale-funnel": t("Tailscale Funnel · 公开", "Tailscale Funnel · Public"),
    "tailscale-https": "",
    tailscale: "Tailscale",
    lan: t("局域网", "Local network"),
    virtual: t("虚拟网络", "Virtual network"),
  };
  const kindHints = {
    public: t(
      "通过 --public-url 配置的地址，登录仍需要访问令牌。",
      "The address configured with --public-url; access still requires a token.",
    ),
    relay: t(
      "经中转访问，TLS 在这台电脑上解开，中转看不到内容。登录仍需要访问令牌。",
      "Through the relay. TLS ends on this computer, so the relay cannot read the content. An access token is still required.",
    ),
    "tailscale-funnel": t(
      "互联网中的任何人都能访问登录页，登录仍需要访问令牌。",
      "Anyone on the Internet can reach the sign-in page. An access token is still required.",
    ),
    "tailscale-https": t(
      "全程加密，支持通知和添加到主屏幕。手机需开着 Tailscale。",
      "Encrypted, and supports notifications and installing to the home screen. Your phone needs Tailscale on.",
    ),
    tailscale: t(
      "手机也登录 Tailscale 后，在任意网络都能连接。",
      "Works from any network once your phone is on Tailscale.",
    ),
    lan: t(
      "需连接同一 Wi-Fi。HTTP 未加密，请只在你信任的网络中使用。",
      "Same Wi-Fi only. HTTP is not encrypted, so use a network you trust.",
    ),
    virtual: t(
      "通常只有这台电脑上的虚拟机能访问。",
      "Usually reachable only from virtual machines on this computer.",
    ),
  };
  return {
    id: "connect-devices",
    label: t("连接设备", "Connect devices"),
    icon: "connections",
    mount({ content, signal }) {
      const document = content.ownerDocument;
      const body = h(document, "section", { className: "console-panel console-connect" });
      const status = h(document, "p", { role: "status" });
      const error = h(document, "p", { role: "alert" });
      const title = h(
        document,
        "h1",
        { className: "settings-section-label" },
        t("连接设备", "Connect devices"),
      );
      content.append(title, status, error, body);
      let state: WebAccessState | undefined;
      let selected: string | undefined;
      let busy = false;
      let restarting = false;
      const request = (method: string, params = {}): Promise<unknown> =>
        consolePost("/api/web/request", { method: `codexhost/${method}`, params }, signal);
      const failure = (cause: unknown): void => {
        if (!signal.aborted)
          error.textContent = cause instanceof Error ? cause.message : String(cause);
      };
      const load = async (): Promise<void> => {
        const data = webAccessStateSchema.parse(await request("accessTokenGet"));
        if (signal.aborted) return;
        state = data;
        render();
      };
      const mutate = async (method: string, params = {}): Promise<void> => {
        busy = true;
        error.textContent = "";
        render();
        try {
          const result = await request(method, params);
          if (method === "tailscaleServeSet") {
            const reply = webServeResultSchema.parse(result);
            if (reply.error) error.textContent = reply.error;
            else if (reply.state.status === "serving") selected = reply.state.url;
          }
          if (method === "lanSet" && (result as { changed: boolean }).changed) {
            restarting = true;
            status.textContent = t(
              "正在重启 Web… 等待恢复连接。",
              "Restarting Web… waiting for reconnection.",
            );
            // Retry reads only. Never repeat a configuration write after a disconnect.
            const target = (params as { enabled: boolean }).enabled;
            const deadline = Date.now() + 60_000;
            while (!signal.aborted) {
              await new Promise((resolve) => setTimeout(resolve, 1_000));
              try {
                await load();
                if (state?.background?.lan === target) break;
              } catch {
                /* Expected during the supervised restart. */
              }
              if (Date.now() >= deadline)
                throw new Error(
                  t(
                    "无法确认 Web 已恢复，请刷新检查。",
                    "Cannot confirm Web recovery. Refresh to check.",
                  ),
                );
            }
          } else await load();
        } finally {
          busy = restarting = false;
          status.textContent = "";
          if (!signal.aborted) render();
        }
      };
      const confirm = (
        title: string,
        description: string,
        method: string,
        params = {},
        extraContent?: Node,
      ): void => {
        confirmAction(
          content,
          signal,
          title,
          description,
          () => mutate(method, params),
          chinese,
          extraContent,
        );
      };
      function render(): void {
        if (!state || signal.aborted) return;
        const data = state;
        const field = (
          label: string,
          value: string,
          copyLabel = t("复制", "Copy"),
        ): HTMLElement => {
          const input = h(document, "input", {
            className: "console-input",
            "aria-label": label,
            readonly: true,
            value,
          });
          input.addEventListener("focus", () => input.select());
          const copy = button(document, copyLabel, () => {
            void navigator.clipboard.writeText(value).then(
              () => {
                copy.textContent = t("已复制", "Copied");
              },
              () => {
                copy.textContent = t("复制失败", "Copy failed");
              },
            );
          });
          return h(
            document,
            "div",
            { className: "console-connect-field" },
            h(document, "p", {}, label),
            h(document, "div", { className: "console-actions" }, input, copy),
          );
        };
        const toggle = (
          label: string,
          enabled: boolean,
          disabled: boolean,
          onChange: () => void,
        ): HTMLElement => {
          const control = h(document, "input", {
            type: "checkbox",
            role: "switch",
            "aria-label": label,
          });
          control.checked = enabled;
          control.disabled = busy || disabled;
          control.addEventListener("change", () => {
            control.checked = enabled;
            onChange();
          });
          return h(
            document,
            "label",
            { className: "console-connect-setting" },
            h(document, "span", {}, label),
            control,
          );
        };
        const route =
          data.networkUrls.find((entry) => entry.url === selected) ?? data.networkUrls[0];
        selected = route?.url;
        const link = route ? `${route.url}#token=${data.secret}` : undefined;
        const routes = h(
          document,
          "fieldset",
          { className: "console-connect-routes" },
          h(document, "legend", {}, t("连接方式", "Connect through")),
        );
        const addRoutes = (container: HTMLElement, kinds: string[]): void => {
          for (const address of kinds.flatMap((kind) =>
            data.networkUrls.filter((entry) => kind === entry.kind),
          )) {
            const radio = h(document, "input", { type: "radio", name: "connection-address" });
            radio.checked = address.url === selected;
            radio.addEventListener("change", () => {
              selected = address.url;
              render();
            });
            container.append(
              h(
                document,
                "label",
                { className: "console-connect-route", "data-connect-route": address.kind },
                radio,
                h(
                  document,
                  "span",
                  { className: "console-connect-route-text" },
                  h(
                    document,
                    "span",
                    { className: "console-connect-route-title" },
                    kindLabels[address.kind],
                    h(
                      document,
                      "span",
                      { className: "console-connect-address" },
                      new URL(address.url).host,
                    ),
                  ),
                  address.url === selected
                    ? h(
                        document,
                        "span",
                        { className: "console-connect-hint" },
                        kindHints[address.kind],
                      )
                    : null,
                ),
              ),
            );
          }
        };
        addRoutes(routes, ["public", "relay"]);
        const direct = h(document, "div", {
          className: "console-connect-group",
          "data-connect-group": "direct",
        });
        if (data.background) {
          const enabled = data.background.lan;
          direct.append(
            toggle(
              t("直连（局域网、Tailscale IP）", "Direct (LAN, Tailscale IP)"),
              enabled,
              false,
              () => {
                confirm(
                  t(
                    enabled ? "关闭直连" : "开启直连",
                    enabled ? "Disable direct access" : "Enable direct access",
                  ),
                  enabled
                    ? t(
                        "Web 将重启，并只监听这台电脑。Web 终端和其他设备会断开，Host 上的任务不受影响。",
                        "Web restarts and listens only on this computer. Web terminals and other devices disconnect; Host tasks continue.",
                      )
                    : t(
                        "Web 将重启，并通过未加密的 HTTP 监听所有 IPv4 网卡。Web 终端会断开，Host 上的任务不受影响。",
                        "Web restarts and listens on every IPv4 interface over unencrypted HTTP. Web terminals disconnect; Host tasks continue.",
                      ),
                  "lanSet",
                  { enabled: !enabled },
                );
              },
            ),
          );
        }
        if (
          direct.childElementCount === 0 &&
          data.networkUrls.some((entry) => ["tailscale", "lan", "virtual"].includes(entry.kind))
        ) {
          direct.append(
            h(
              document,
              "span",
              { className: "console-connect-setting" },
              t("直连（局域网、Tailscale IP）", "Direct (LAN, Tailscale IP)"),
            ),
          );
        }
        addRoutes(direct, ["tailscale", "lan"]);
        const virtual = data.networkUrls.filter((entry) => entry.kind === "virtual");
        if (virtual.length > 0) {
          const other = h(
            document,
            "details",
            {
              className: "console-connect-other",
              open:
                body.querySelector("details")?.open ??
                !data.networkUrls.some((entry) => ["tailscale", "lan"].includes(entry.kind)),
            },
            h(
              document,
              "summary",
              {},
              t(`其他地址（${virtual.length}）`, `Other addresses (${virtual.length})`),
            ),
          );
          addRoutes(other, ["virtual"]);
          direct.append(other);
        }
        if (direct.childElementCount > 0) routes.append(direct);
        const serving = data.tailscale.status === "serving";
        const serve = h(document, "div", {
          className: "console-connect-group",
          "data-connect-group": "tailscale",
        });
        routes.append(serve);
        serve.append(
          toggle(
            "Tailscale HTTPS",
            serving,
            !["serving", "not-serving"].includes(data.tailscale.status),
            () => {
              confirm(
                t(
                  serving ? "关闭 Tailscale Serve" : "开启 Tailscale Serve",
                  serving ? "Disable Tailscale Serve" : "Enable Tailscale Serve",
                ),
                serving
                  ? t(
                      "仅移除指向当前 Web 的根路径转发？其他路径和端口将保留。",
                      "Remove only the root forwarding to this Web server? Other paths and ports will be kept.",
                    )
                  : t(
                      "将 HTTPS 根路径转发到当前 Web？Web 退出后配置仍保留，占用同一端口的其他程序也会被转发。",
                      "Forward the HTTPS root to this Web server? This stays configured after Web exits, and another program using this port would also be forwarded.",
                    ),
                "tailscaleServeSet",
                { enabled: !serving },
                data.tailscale.status === "not-serving"
                  ? field(
                      t("Serve 命令", "Serve command"),
                      data.tailscale.command,
                      t("复制命令", "Copy command"),
                    )
                  : undefined,
              );
            },
          ),
        );
        if (data.tailscale.status !== "not-serving" && data.tailscale.status !== "serving") {
          const hints = {
            "not-installed": t(
              "未检测到 Tailscale。请安装其 CLI 后使用 Serve。",
              "Install the Tailscale CLI to use Serve.",
            ),
            "not-running": t(
              "Tailscale 未运行，请先在这台电脑上启动 Tailscale。",
              "Start Tailscale on this computer first.",
            ),
            "not-logged-in": t(
              "请先在这台电脑上登录 Tailscale。",
              "Sign in to Tailscale on this computer first.",
            ),
            "https-disabled": t(
              "请先在 Tailscale 管理后台开启 HTTPS 证书。",
              "Enable HTTPS certificates in Tailscale first.",
            ),
            occupied: t(
              "HTTPS 443 根路径已转发到别处：",
              "HTTPS 443 root already forwards elsewhere: ",
            ),
            error: t("无法读取 Tailscale 状态：", "Could not read Tailscale state: "),
          };
          serve.append(
            h(
              document,
              "p",
              {},
              hints[data.tailscale.status] +
                (data.tailscale.status === "occupied"
                  ? data.tailscale.target
                  : data.tailscale.status === "error"
                    ? data.tailscale.message
                    : ""),
            ),
          );
        }
        addRoutes(serve, ["tailscale-https", "tailscale-funnel"]);
        const qr = h(document, "div", { className: "console-connect-qr" });
        if (link) {
          const code = encode(link, { ecc: "M", border: 2 });
          const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          svg.setAttribute("viewBox", `0 0 ${code.size} ${code.size}`);
          svg.setAttribute("role", "img");
          svg.setAttribute("aria-label", t("登录二维码", "Sign-in QR code"));
          const plate = document.createElementNS(svg.namespaceURI, "rect");
          plate.setAttribute("width", "100%");
          plate.setAttribute("height", "100%");
          plate.setAttribute("fill", "#fff");
          const modules = document.createElementNS(svg.namespaceURI, "path");
          modules.setAttribute("fill", "#000");
          modules.setAttribute(
            "d",
            code.data
              .flatMap((row, y) => row.map((dark, x) => (dark ? `M${x} ${y}h1v1h-1z` : "")))
              .join(""),
          );
          svg.append(plate, modules);
          const enlarge = button(document, svg, () => {
            qr.classList.toggle("is-enlarged");
          });
          enlarge.setAttribute("aria-label", t("放大或缩小二维码", "Resize QR code"));
          qr.append(enlarge);
        }
        body.replaceChildren(
          h(document, "div", { className: "console-connect-main" }, qr, routes),
          field(
            link ? t("登录链接", "Sign-in link") : t("访问令牌", "Access token"),
            link ?? data.secret,
          ),
          h(
            document,
            "p",
            {},
            t(
              "二维码和链接都包含访问令牌，拿到的人可以操作这台电脑，请勿外传。",
              "The QR code and link contain an access token that grants control of this computer. Keep them private.",
            ),
          ),
        );
        if (route?.kind === "public" && route.url.startsWith("http:"))
          body.append(
            h(
              document,
              "p",
              {},
              t(
                "此 HTTP 地址以明文传输内容，请只在你信任的网络中使用。",
                "This HTTP address is unencrypted. Use only trusted networks.",
              ),
            ),
          );
        if (data.background) {
          const background = data.background;
          body.append(
            toggle(
              t("登录后自动启动", "Start at login"),
              background.autostart.status === "on",
              restarting,
              () => {
                void mutate("autostartSet", {
                  enabled: background.autostart.status !== "on",
                }).catch(failure);
              },
            ),
          );
          if (background.autostart.status === "invalid")
            body.append(h(document, "p", { role: "alert" }, background.autostart.reason));
        }
        const regenerate = button(document, t("重新生成令牌…", "Regenerate token…"), () => {
          confirm(
            t("重新生成访问令牌？", "Regenerate access token?"),
            t(
              "其他设备会立即退出登录，需要重新扫码。运行中的任务不受影响。",
              "Every other device is signed out immediately and has to scan the new QR code. Running tasks are not affected.",
            ),
            "accessTokenRegenerate",
          );
        });
        regenerate.disabled = busy;
        body.append(
          h(
            document,
            "p",
            {},
            data.lastUsedAt === null
              ? t("还没有设备登录", "No device has signed in yet")
              : `${t("最近使用：", "Last used: ")}${new Date(data.lastUsedAt).toLocaleString(locale)}`,
          ),
          regenerate,
        );
      }
      status.textContent = t("正在加载…", "Loading…");
      void load()
        .catch((cause: unknown) => {
          if (signal.aborted) return;
          failure(cause);
          const open = button(document, t("启动并打开 Web", "Start and open Web"), () => {
            open.disabled = true;
            void consolePost("/api/web/open", {}, signal)
              .then(() => {
                error.textContent = "";
                return load();
              })
              .catch(failure)
              .finally(() => {
                open.disabled = false;
              });
          });
          body.append(open);
        })
        .finally(() => {
          status.textContent = "";
        });
    },
  };
}

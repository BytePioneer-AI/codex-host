import { consoleGet, consolePost } from "../api.js";
import { button, formatTime, h } from "../dom.js";
import type { ConsoleMessages } from "../messages.js";
import type {
  RendererSettingsPageDefinition,
  RendererSettingsPageMountContext,
} from "../../settings/core.js";

type ClientScope = "read" | "dispatch";
type ClientNetwork = "local" | "tailnet" | "public";

interface ListenerStatus {
  state: "off" | "on" | "unavailable";
  endpoint?: string;
  mcpUrl?: string;
  reason?: string;
}

interface WebhookState {
  delivered: number;
  attempts?: number;
  nextAttemptAt?: number;
  lastSuccessAt?: string;
  lastFailure?: { eventId: number; at: string; reason: string; final: boolean };
}

interface ExternalClientRow {
  name: string;
  createdAt: string;
  scope: ClientScope;
  networks: ClientNetwork[];
  lastAccess?: { network: ClientNetwork; at: string };
  webhook: {
    adapter: string;
    url: string;
    keyConfigured: boolean;
    state: WebhookState;
  } | null;
}

export interface ExternalClientsSnapshot {
  settings: { tailnet: boolean; public: boolean };
  listeners: {
    local: ListenerStatus;
    tailnet: ListenerStatus;
    public: ListenerStatus;
    updatedAt?: string;
  };
  clients: ExternalClientRow[];
}

function listenerBadge(
  document: Document,
  status: ListenerStatus,
  copy: ConsoleMessages["externalClients"],
): HTMLElement {
  const tone = status.state === "on" ? " is-ok" : status.state === "unavailable" ? " is-warn" : "";
  const text =
    status.state === "on"
      ? copy.listenerOn
      : status.state === "unavailable"
        ? copy.listenerUnavailable
        : copy.listenerOff;
  return h(document, "span", { className: `console-badge${tone}` }, text);
}

/**
 * Console page for external client access: local/tailnet/public listener status,
 * Funnel MCP URL, tailnet/public switches, client scopes/networks, last access,
 * and webhook delivery state.
 */
export function createExternalClientsPage(
  messages: ConsoleMessages,
  locale: string,
): RendererSettingsPageDefinition {
  const copy = messages.externalClients;
  return Object.freeze({
    id: "external-clients",
    label: copy.label,
    icon: "gateway" as const,
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const body = h(document, "div", {});
      let snapshot: ExternalClientsSnapshot | null = null;
      let busy = false;
      let errorText: string | null = null;

      const toggle = (patch: { tailnet?: boolean; public?: boolean }): void => {
        busy = true;
        errorText = null;
        render();
        void consolePost<ExternalClientsSnapshot>("/api/external-clients/access", patch)
          .then((next) => {
            snapshot = next;
          })
          .catch((error: unknown) => {
            errorText = error instanceof Error ? error.message : String(error);
          })
          .finally(() => {
            busy = false;
            render();
          });
      };

      const renderListener = (
        key: "local" | "tailnet" | "public",
        title: string,
        status: ListenerStatus,
        enabled?: boolean,
      ): HTMLElement => {
        const actions =
          enabled === undefined
            ? null
            : button(
                document,
                enabled ? copy.disable : copy.enable,
                () => toggle(key === "tailnet" ? { tailnet: !enabled } : { public: !enabled }),
                enabled ? "secondary" : "primary",
              );
        if (actions) {
          actions.disabled = busy;
          actions.setAttribute("data-listener-toggle", key);
        }
        const facts: HTMLElement[] = [];
        if (status.endpoint) {
          facts.push(h(document, "dt", {}, copy.endpoint), h(document, "dd", {}, status.endpoint));
        }
        if (status.mcpUrl) {
          facts.push(h(document, "dt", {}, copy.mcpUrl), h(document, "dd", {}, status.mcpUrl));
        }
        return h(
          document,
          "section",
          { className: "console-panel", "data-listener": key },
          h(
            document,
            "div",
            { className: "console-panel__header" },
            h(
              document,
              "div",
              { className: "console-actions" },
              h(document, "h3", { className: "console-panel__title" }, title),
              listenerBadge(document, status, copy),
            ),
            actions,
          ),
          facts.length > 0 ? h(document, "dl", { className: "console-facts" }, ...facts) : null,
          status.reason
            ? h(document, "p", { className: "console-muted", "data-tone": "bad" }, status.reason)
            : null,
        );
      };

      const renderWebhook = (client: ExternalClientRow): HTMLElement => {
        if (!client.webhook) {
          return h(document, "span", { className: "console-muted" }, copy.webhookNone);
        }
        const { adapter, url, state } = client.webhook;
        const lines: HTMLElement[] = [
          h(document, "div", {}, `${adapter} · ${url}`),
          h(
            document,
            "div",
            { className: "console-muted" },
            [
              copy.webhookDelivered.replace("{id}", String(state.delivered)),
              state.lastSuccessAt
                ? copy.webhookLastSuccess.replace(
                    "{time}",
                    formatTime(Date.parse(state.lastSuccessAt), locale),
                  )
                : "",
            ]
              .filter(Boolean)
              .join(" · "),
          ),
        ];
        if (state.lastFailure) {
          const failure = state.lastFailure;
          const text = failure.final
            ? (/^HTTP 40[13]$/u.test(failure.reason) ? copy.webhookRejected : copy.webhookDropped)
                .replace("{id}", String(failure.eventId))
                .replace("{reason}", failure.reason)
            : copy.webhookRetrying
                .replace("{id}", String(failure.eventId))
                .replace("{attempts}", String(state.attempts ?? 1))
                .replace("{reason}", failure.reason);
          lines.push(
            h(
              document,
              "div",
              { className: "console-muted", "data-tone": failure.final ? "bad" : undefined },
              text,
            ),
          );
        }
        return h(document, "div", {}, ...lines);
      };

      const renderClient = (client: ExternalClientRow): HTMLElement => {
        const networks = client.networks
          .map((network) => copy.networkLabels[network] ?? network)
          .join(", ");
        const lastAccess = client.lastAccess
          ? `${copy.networkLabels[client.lastAccess.network] ?? client.lastAccess.network} · ${formatTime(Date.parse(client.lastAccess.at), locale)}`
          : copy.neverAccessed;
        return h(
          document,
          "section",
          { className: "console-panel", "data-client": client.name },
          h(
            document,
            "div",
            { className: "console-panel__header" },
            h(document, "h3", { className: "console-panel__title" }, client.name),
            h(
              document,
              "span",
              { className: `console-badge${client.scope === "dispatch" ? " is-info" : ""}` },
              client.scope === "dispatch" ? copy.scopeDispatch : copy.scopeRead,
            ),
          ),
          h(
            document,
            "dl",
            { className: "console-facts" },
            h(document, "dt", {}, copy.networks),
            h(document, "dd", {}, networks),
            h(document, "dt", {}, copy.lastAccess),
            h(document, "dd", {}, lastAccess),
            h(document, "dt", {}, copy.webhook),
            h(document, "dd", {}, renderWebhook(client)),
          ),
        );
      };

      const render = (): void => {
        if (!snapshot) {
          body.replaceChildren(
            h(document, "p", { className: "console-muted" }, errorText ?? messages.statusLoading),
          );
          return;
        }
        const { settings, listeners, clients } = snapshot;
        body.replaceChildren(
          ...(errorText
            ? [h(document, "p", { className: "console-muted", "data-tone": "bad" }, errorText)]
            : []),
          h(document, "h2", { className: "console-section-title" }, copy.listenersTitle),
          h(document, "p", { className: "console-muted" }, copy.applyNote),
          renderListener("local", copy.localListener, listeners.local),
          renderListener("tailnet", copy.tailnetListener, listeners.tailnet, settings.tailnet),
          renderListener("public", copy.publicListener, listeners.public, settings.public),
          h(document, "h2", { className: "console-section-title" }, copy.clientsTitle),
          ...(clients.length > 0
            ? clients.map(renderClient)
            : [h(document, "p", { className: "console-muted" }, copy.noClients)]),
        );
      };

      context.content.replaceChildren(
        h(document, "h1", { className: "settings-section-label" }, copy.label),
        body,
      );
      render();
      void context.runLatest(
        (signal) => consoleGet<ExternalClientsSnapshot>("/api/external-clients", signal),
        {
          success(value) {
            snapshot = value;
            render();
          },
          failure(error) {
            errorText = error instanceof Error ? error.message : String(error);
            render();
          },
        },
      );
      return undefined;
    },
  });
}

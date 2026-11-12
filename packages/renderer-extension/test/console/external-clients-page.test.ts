import { describe, expect, it, vi } from "vitest";

import { consoleMessages } from "../../src/console/messages.js";
import {
  createExternalClientsPage,
  type ExternalClientsSnapshot,
} from "../../src/console/pages/external-clients.js";
import type { RendererSettingsPageMountContext } from "../../src/settings/core.js";

const consoleGet = vi.fn();
const consolePost = vi.fn();

vi.mock("../../src/console/api.js", () => ({
  consoleGet: (...args: unknown[]) => consoleGet(...args),
  consolePost: (...args: unknown[]) => consolePost(...args),
}));

vi.mock("../../src/console/dom.js", () => ({
  formatTime: () => "12:00",
  button: (_document: Document, label: string, onClick: () => void, variant = "secondary") => {
    const attributes: Record<string, string> = {};
    return {
      tag: "button",
      label,
      variant,
      disabled: false,
      attributes,
      onClick,
      setAttribute(name: string, value: string) {
        attributes[name] = value;
      },
    };
  },
  h: (_document: Document, tag: string, attributes: object, ...children: unknown[]) => ({
    tag,
    attributes,
    children,
    replaceChildren(...items: unknown[]) {
      children.splice(0, children.length, ...items);
    },
  }),
}));

function snapshot(): ExternalClientsSnapshot {
  return {
    settings: { tailnet: true, public: false },
    listeners: {
      local: { state: "on", endpoint: "http://127.0.0.1:41900" },
      tailnet: { state: "on", endpoint: "http://100.64.0.1:41901" },
      public: { state: "off", mcpUrl: "https://host.example.ts.net/codexhost/mcp" },
      updatedAt: "2026-11-04T00:05:00Z",
    },
    clients: [
      {
        name: "grok-bot",
        createdAt: "2026-11-04T00:00:00Z",
        scope: "dispatch",
        networks: ["local", "tailnet"],
        lastAccess: { network: "tailnet", at: "2026-11-04T01:00:00Z" },
        webhook: {
          adapter: "grok-bot",
          url: "https://bot.example/webhook",
          keyConfigured: true,
          state: {
            delivered: 42,
            lastSuccessAt: "2026-11-04T01:02:00Z",
          },
        },
      },
    ],
  };
}

describe("external clients console page", () => {
  it("renders listeners, Funnel MCP URL, client scopes/networks/lastAccess, and webhook state, and toggles switches", async () => {
    const initial = snapshot();
    consoleGet.mockResolvedValueOnce(initial);
    const updated: ExternalClientsSnapshot = {
      ...initial,
      settings: { tailnet: true, public: true },
      listeners: {
        ...initial.listeners,
        public: { state: "on", mcpUrl: "https://host.example.ts.net/codexhost/mcp" },
      },
    };
    consolePost.mockResolvedValueOnce(updated);

    const children: unknown[] = [];
    const context = {
      content: {
        ownerDocument: {},
        replaceChildren(...items: unknown[]) {
          children.splice(0, children.length, ...items);
        },
      },
      async runLatest<T>(
        load: (signal: AbortSignal) => Promise<T>,
        handlers: { success(value: T): void; failure(error: unknown): void },
      ) {
        try {
          handlers.success(await load(new AbortController().signal));
        } catch (error) {
          handlers.failure(error);
        }
      },
    } as unknown as RendererSettingsPageMountContext;

    const page = createExternalClientsPage(consoleMessages("zh-CN"), "zh-CN");
    page.mount(context);
    await vi.waitFor(() => {
      expect(JSON.stringify(children)).toContain("grok-bot");
    });

    const rendered = JSON.stringify(children);
    expect(rendered).toContain("http://127.0.0.1:41900");
    expect(rendered).toContain("http://100.64.0.1:41901");
    expect(rendered).toContain("https://host.example.ts.net/codexhost/mcp");
    expect(rendered).toContain("派发（dispatch）");
    expect(rendered).toContain("本机（local）, Tailnet");
    expect(rendered).toContain("Tailnet · 12:00");
    expect(rendered).toContain("grok-bot · https://bot.example/webhook");
    expect(rendered).toContain("最后确认事件 #42");

    // Find the public toggle button and trigger it
    const findButtons = (
      node: unknown,
    ): Array<{ attributes?: Record<string, string>; onClick?: () => void }> => {
      if (Array.isArray(node)) return node.flatMap(findButtons);
      if (!node || typeof node !== "object") return [];
      const record = node as {
        tag?: string;
        attributes?: Record<string, string>;
        onClick?: () => void;
        children?: unknown[];
      };
      const found = record.tag === "button" ? [record] : [];
      if (Array.isArray(record.children)) {
        for (const child of record.children) found.push(...findButtons(child));
      }
      return found;
    };
    const publicToggle = findButtons(children).find(
      (btn) => btn.attributes?.["data-listener-toggle"] === "public",
    );
    expect(publicToggle).toBeDefined();
    publicToggle?.onClick?.();

    await vi.waitFor(() => {
      expect(consolePost).toHaveBeenCalledWith("/api/external-clients/access", { public: true });
    });
  });

  it("names a 401 or 403 rejection as a webhook configuration error", async () => {
    const rejected = snapshot();
    const client = rejected.clients[0];
    if (!client?.webhook) throw new Error("fixture has a webhook");
    client.webhook.state = {
      delivered: 42,
      lastFailure: { eventId: 43, at: "2026-11-04T01:03:00Z", reason: "HTTP 401", final: true },
    };
    const other = snapshot();
    const otherClient = other.clients[0];
    if (!otherClient?.webhook) throw new Error("fixture has a webhook");
    otherClient.webhook.state = {
      delivered: 42,
      lastFailure: { eventId: 44, at: "2026-11-04T01:03:00Z", reason: "HTTP 404", final: true },
    };
    const render = async (value: ExternalClientsSnapshot) => {
      consoleGet.mockResolvedValueOnce(value);
      const children: unknown[] = [];
      const context = {
        content: {
          ownerDocument: {},
          replaceChildren(...items: unknown[]) {
            children.splice(0, children.length, ...items);
          },
        },
        async runLatest<T>(
          load: (signal: AbortSignal) => Promise<T>,
          handlers: { success(value: T): void; failure(error: unknown): void },
        ) {
          handlers.success(await load(new AbortController().signal));
        },
      } as unknown as RendererSettingsPageMountContext;
      createExternalClientsPage(consoleMessages("zh-CN"), "zh-CN").mount(context);
      await vi.waitFor(() => expect(JSON.stringify(children)).toContain("grok-bot"));
      return JSON.stringify(children);
    };
    const misconfigured = await render(rejected);
    expect(misconfigured).toContain("事件 #43 被目标拒绝（HTTP 401）：webhook 配置有误");
    const generic = await render(other);
    expect(generic).toContain("事件 #44 投递失败：HTTP 404");
    expect(generic).not.toContain("配置有误");
  });
});

import { createConnection, createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { startControllerAttachmentServer } from "../src/controller-attachment-server.js";
import { createLocalPageOpener, type LocalPageHandle } from "../src/local-page-control.js";
import { openRendererLocalPage } from "../src/renderer-local-page.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

const nonce = "1234567890abcdef1234567890abcdef";
async function setup(openLocalPage: (url: string) => Promise<LocalPageHandle>) {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const server = await startControllerAttachmentServer({
    port: address.port,
    nonce,
    attach: async () => {},
    openLocalPage,
  });
  const environment = {
    CODEXHOST_CONTROL_PORT: String(address.port),
    CODEXHOST_CONTROL_NONCE: nonce,
  };
  return {
    server,
    environment,
    port: address.port,
    open: required(createLocalPageOpener(environment)),
  };
}
const url = "http://127.0.0.1:43210/?token=fixture";
describe("Owned Desktop local pages", () => {
  it("opens in background, shows on demand, and independently closes its own page", async () => {
    const pages = [0, 1].map(() => ({ show: vi.fn(async () => {}), close: vi.fn(async () => {}) }));
    let next = 0;
    const fixture = await setup(async () => required(pages[next++]));
    try {
      const a = await fixture.open(url),
        b = await fixture.open(url);
      expect(required(pages[0]).show).not.toHaveBeenCalled();
      await a.show();
      expect(required(pages[0]).show).toHaveBeenCalledOnce();
      await a.close();
      expect(required(pages[0]).close).toHaveBeenCalled();
      expect(required(pages[1]).close).not.toHaveBeenCalled();
      await b.close();
    } finally {
      await fixture.server.close();
    }
  });
  it("releases a page that finishes opening after its owner disconnects", async () => {
    const ready = Promise.withResolvers<LocalPageHandle>();
    const open = vi.fn(async () => ready.promise);
    const fixture = await setup(open);
    const socket = createConnection({ host: "127.0.0.1", port: fixture.port });
    const close = vi.fn(async () => {});
    try {
      socket.write(`PAGE ${nonce} ${url}\n`);
      await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
      socket.destroy();
      ready.resolve({ show: async () => {}, close });
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    } finally {
      socket.destroy();
      await fixture.server.close();
    }
  });
  it("requires the controller nonce and rejects remote URLs without calling the opener", async () => {
    const open = vi.fn(async () => ({ show: async () => {}, close: async () => {} }));
    const fixture = await setup(open);
    try {
      const wrong = required(
        createLocalPageOpener({
          ...fixture.environment,
          CODEXHOST_CONTROL_NONCE: "0".repeat(32),
        }),
      );
      await expect(wrong(url)).rejects.toThrow("unavailable");
      await expect(fixture.open("https://example.com/")).rejects.toThrow("loopback");
      expect(open).not.toHaveBeenCalled();
    } finally {
      await fixture.server.close();
    }
  });
  it("closes pages when the controller stops", async () => {
    const close = vi.fn(async () => {});
    const fixture = await setup(async () => ({ show: async () => {}, close }));
    const page = await fixture.open(url);
    await fixture.server.close();
    expect(close).toHaveBeenCalledOnce();
    await page.close();
  });
  it("uses native tab messages and keeps the owner identity when the visible task changes", async () => {
    let current = "owner";
    const expressions: string[] = [];
    const execute = async <T>(expression: string): Promise<T> => {
      expressions.push(expression);
      if (!expression.includes("currentThreadId")) expect(expression).toMatch(/; null$/u);
      return (expression.includes("currentThreadId") ? current : null) as T;
    };
    const page = await openRendererLocalPage(execute, url, async () => [{ url }]);
    expect(expressions[1]).toContain('"active":false');
    current = "different";
    await page.show();
    expect(expressions.join("\n")).toContain('"path":"/local/owner"');
    await page.close();
    await page.close();
    expect(expressions.filter((e) => e.includes('"type":"close-browser-tab"'))).toHaveLength(1);
    expect(expressions.at(-1)).toContain('"conversationId":"owner"');
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRendererRequestSender,
  RendererRequestTransportError,
} from "../src/renderer-request-sender.js";
import { webRequestManager } from "../src/web-request-manager.js";

const method = "codexhost/update/start";
afterEach(() => vi.unstubAllGlobals());

describe("Web request failure classification", () => {
  it("preserves successful RPC results", async () => {
    const fetch = vi.fn(async () => Response.json({ result: { phase: "prepared" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(webRequestManager().sendRequest(method, {})).resolves.toEqual({
      phase: "prepared",
    });
    expect(fetch).toHaveBeenCalledWith(
      "api/ch/v1/rpc",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ method, params: {} }),
      }),
    );
  });

  it.each(["fetch", "response-body"] as const)(
    "marks %s interruption as an unknown outcome through the renderer request sender",
    async (point) => {
      const interrupted = new TypeError("Network connection interrupted");
      const fetch = vi.fn<() => Promise<Response>>();
      if (point === "fetch") fetch.mockRejectedValue(interrupted);
      else {
        fetch.mockResolvedValue({
          ok: true,
          json: () => Promise.reject(interrupted),
        } as Response);
      }
      vi.stubGlobal("fetch", fetch);
      const send = createRendererRequestSender(webRequestManager().sendRequest);
      const result = send(method, {});
      await expect(result).rejects.toBeInstanceOf(RendererRequestTransportError);
      await expect(result).rejects.toMatchObject({ cause: interrupted });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("treats a truncated JSON response as unknown rather than a rejected update", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"result":')),
    );
    await expect(webRequestManager().sendRequest(method, {})).rejects.toBeInstanceOf(
      RendererRequestTransportError,
    );
  });

  it("preserves an explicit RPC rejection without calling it a transport interruption", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { code: -32000, message: "Update is unavailable" } },
          { status: 400 },
        ),
      ),
    );
    const result = webRequestManager().sendRequest(method, {});
    await expect(result).rejects.toMatchObject({ code: -32000, message: "Update is unavailable" });
    await expect(result).rejects.not.toBeInstanceOf(RendererRequestTransportError);
  });

  it("preserves a deliberate abort", async () => {
    const controller = new AbortController();
    const aborted = new DOMException("Aborted", "AbortError");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(aborted)),
    );
    controller.abort();
    await expect(webRequestManager().sendRequest(method, {}, controller.signal)).rejects.toBe(
      aborted,
    );
  });
});

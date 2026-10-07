import { describe, expect, it, vi } from "vitest";
import type {
  RendererHostRoute,
  RendererHostRouting,
} from "@codexhost/desktop-control/renderer-bindings";
import { createRendererHostClients } from "../src/renderer-host-clients.js";

const image = { type: "image", url: "data:image/png;base64,aGVsbG8=" };

function fixture(hostId = "ssh:remote", provider = "codexhost") {
  const rpc = vi.fn(async (...args: unknown[]) => {
    void args;
    return { turn: { id: "turn" } };
  });
  const createFileAttachment = vi.fn(async ({ label }: { contents: Blob; label: string }) => ({
    label,
    path: `/remote/.codex/attachments/id/${label}`,
    fsPath: `/remote/.codex/attachments/id/${label}`,
  }));
  const manager = {
    sendRequest: rpc,
    createFileAttachment,
    removePastedTextAttachment: vi.fn(async (path: string) => {
      void path;
    }),
    getConversation: (id: string) => ({ id, modelProvider: provider }),
    getHostId: () => hostId,
    startTurn: vi.fn(),
    steerTurn: vi.fn(),
    getTurnCoordinator: () => ({}),
  };
  let current: RendererHostRoute | null = {
    hostId,
    manager,
    policy: {},
  } as unknown as RendererHostRoute;
  const routing = { forHost: () => current } as unknown as RendererHostRouting;
  const clients = createRendererHostClients(() => routing);
  clients.forHost(hostId);
  return {
    manager,
    rpc,
    createFileAttachment,
    retire: () => {
      current = null;
    },
    dispose: () => clients.dispose(),
  };
}

function request(input: unknown[] = [{ type: "text", text: "Describe this" }, image]) {
  return { threadId: "thread", clientUserMessageId: "message", input };
}

function submittedText(rpc: ReturnType<typeof fixture>["rpc"]): string {
  const params = rpc.mock.calls.at(-1)?.[1] as ReturnType<typeof request>;
  return params.input
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" && item !== null && "type" in item && item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

describe("remote external attachments through the native Desktop file store", () => {
  it("uploads inline images before sending, retaining the image preview and text contract", async () => {
    const f = fixture();
    const params = request();
    const options = { timeoutMs: 30_000 };
    try {
      await f.manager.sendRequest("turn/start", params, options);
      expect(f.createFileAttachment).toHaveBeenCalledOnce();
      const upload = f.createFileAttachment.mock.calls[0]?.[0];
      if (!upload) throw new Error("No native upload");
      expect(upload.contents.type).toBe("image/png");
      expect(await upload.contents.text()).toBe("hello");
      expect(submittedText(f.rpc)).toContain(`/remote/.codex/attachments/id/${upload.label}`);
      expect(submittedText(f.rpc)).toContain("Image attachment: true");
      expect(submittedText(f.rpc)).toContain("Describe this");
      expect(f.rpc.mock.calls[0]?.[2]).toBe(options);
      const sent = f.rpc.mock.calls[0]?.[1] as ReturnType<typeof request>;
      expect(sent.input).toContain(image);
      expect(params).toEqual(request());
    } finally {
      f.dispose();
    }
  });

  it("does not submit while the native upload is pending or after it fails", async () => {
    const f = fixture();
    const upload = Promise.withResolvers<never>();
    f.createFileAttachment.mockReturnValue(upload.promise);
    try {
      const pending = f.manager.sendRequest("turn/start", request());
      const rejected = expect(pending).rejects.toThrow("upload failed");
      await vi.waitFor(() => expect(f.createFileAttachment).toHaveBeenCalledOnce());
      expect(f.rpc).not.toHaveBeenCalled();
      upload.reject(new Error("upload failed"));
      await rejected;
      expect(f.rpc).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });

  it("reuses native remote image paths without creating another upload", async () => {
    const f = fixture();
    const params = request([
      {
        type: "text",
        text: "# Files mentioned by the user:\n\n## original.png: /remote/.codex/attachments/native/original.png\nImage attachment: true\n\n## My request:\nDescribe this",
      },
      image,
    ]);
    try {
      await f.manager.sendRequest("turn/start", params);
      expect(f.createFileAttachment).not.toHaveBeenCalled();
      expect(f.rpc.mock.calls[0]?.[1]).toBe(params);
    } finally {
      f.dispose();
    }
  });

  it("does not mistake an example in the user's request for native attachment context", async () => {
    const f = fixture();
    try {
      await f.manager.sendRequest(
        "turn/start",
        request([
          {
            type: "text",
            text: "## My request:\n# Files mentioned by the user:\n## example.png: /example.png\nImage attachment: true\n",
          },
          image,
        ]),
      );
      expect(f.createFileAttachment).toHaveBeenCalledOnce();
    } finally {
      f.dispose();
    }
  });

  it("keeps ordinary file references and non-submission RPCs unchanged", async () => {
    const f = fixture();
    const params = request([
      {
        type: "text",
        text: "# Files mentioned by the user:\n## map.xmind: /remote/.codex/attachments/map.xmind\n\n## My request:\nRead it",
      },
    ]);
    try {
      await f.manager.sendRequest("turn/start", params);
      await f.manager.sendRequest("thread/read", request());
      expect(f.rpc.mock.calls[0]?.[1]).toBe(params);
      expect(f.createFileAttachment).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });

  it("makes an image-only turn usable through the existing text-only Host parser", async () => {
    const f = fixture();
    try {
      await f.manager.sendRequest("turn/start", request([image]));
      expect(submittedText(f.rpc)).toContain("/remote/.codex/attachments/id/image-1.png");
      expect(submittedText(f.rpc).trim()).not.toBe("");
    } finally {
      f.dispose();
    }
  });

  it("preserves an explicit target-host localImage path without another upload", async () => {
    const f = fixture();
    try {
      await f.manager.sendRequest(
        "turn/start",
        request([{ type: "localImage", path: "/remote/picture.png" }]),
      );
      expect(f.createFileAttachment).not.toHaveBeenCalled();
      expect(submittedText(f.rpc)).toContain("## picture.png: /remote/picture.png");
    } finally {
      f.dispose();
    }
  });

  it.each([
    "https://example.com/image.png",
    "data:text/html;base64,aGVsbG8=",
    "data:image/png;base64,%%%",
    "data:image/png;base64,",
    "data:image/png;base64,a===",
    "data:image/png;base64,Zh==", // Non-canonical padding bits.
  ])("rejects invalid or unsupported image data before uploading: %s", async (url) => {
    const f = fixture();
    try {
      await expect(
        f.manager.sendRequest("turn/start", request([image, { type: "image", url }])),
      ).rejects.toThrow(/attachment/);
      expect(f.createFileAttachment).not.toHaveBeenCalled();
      expect(f.rpc).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });

  it("bounds attachment count and size before upload", async () => {
    const f = fixture();
    try {
      await expect(
        f.manager.sendRequest("turn/start", request(Array.from({ length: 21 }, () => image))),
      ).rejects.toThrow("maximum 20");
      const large = { type: "image", url: `data:image/png;base64,${"A".repeat(28 * 1024 * 1024)}` };
      await expect(f.manager.sendRequest("turn/start", request([large]))).rejects.toThrow("20 MiB");
      expect(f.createFileAttachment).not.toHaveBeenCalled();
      expect(f.rpc).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });

  it("does not guess image-to-path associations when native context is incomplete", async () => {
    const f = fixture();
    const params = request([
      {
        type: "text",
        text: "# Files mentioned by the user:\n## second.png: /remote/second.png\nImage attachment: true\n\n## My request:\nCompare",
      },
      image,
      { type: "image", url: "data:image/jpeg;base64,d29ybGQ=" },
    ]);
    try {
      await f.manager.sendRequest("turn/start", params);
      expect(f.createFileAttachment).toHaveBeenCalledTimes(2);
      expect(submittedText(f.rpc)).toContain("image-1.png");
      expect(submittedText(f.rpc)).toContain("image-2.jpg");
      expect(submittedText(f.rpc)).toContain("/remote/second.png");
    } finally {
      f.dispose();
    }
  });

  it.each(["dispose", "retire"] as const)(
    "does not send after the connection is retired via %s",
    async (action) => {
      const f = fixture();
      const upload = Promise.withResolvers<Awaited<ReturnType<typeof f.createFileAttachment>>>();
      f.createFileAttachment.mockReturnValue(upload.promise);
      try {
        const pending = f.manager.sendRequest("turn/start", request());
        const rejected = expect(pending).rejects.toThrow("no longer available");
        await vi.waitFor(() => expect(f.createFileAttachment).toHaveBeenCalledOnce());
        f[action]();
        upload.resolve({
          label: "image.png",
          path: "/remote/image.png",
          fsPath: "/remote/image.png",
        });
        await rejected;
        expect(f.rpc).not.toHaveBeenCalled();
      } finally {
        f.dispose();
      }
    },
  );

  it("cleans only newly created files on preparation failure and allows an explicit retry", async () => {
    const f = fixture();
    const params = request([image, image]);
    const original = f.createFileAttachment.getMockImplementation();
    if (!original) throw new Error("No native upload implementation");
    f.createFileAttachment
      .mockImplementationOnce(original)
      .mockRejectedValueOnce(new Error("upload failed"));
    try {
      await expect(f.manager.sendRequest("turn/start", params)).rejects.toThrow("upload failed");
      expect(f.rpc).not.toHaveBeenCalled();
      expect(f.manager.removePastedTextAttachment).toHaveBeenCalledExactlyOnceWith(
        "/remote/.codex/attachments/id/image-1.png",
      );
      await f.manager.sendRequest("turn/start", params);
      expect(f.rpc).toHaveBeenCalledOnce();
    } finally {
      f.dispose();
    }
  });

  it("retains uploaded files after a dispatched Turn fails with an unknown outcome", async () => {
    const f = fixture();
    const params = request();
    f.rpc.mockRejectedValueOnce(new Error("outcome unknown"));
    try {
      await expect(f.manager.sendRequest("turn/start", params)).rejects.toThrow("outcome unknown");
      expect(f.manager.removePastedTextAttachment).not.toHaveBeenCalled();
      // Reusing a request does not re-upload; the wrapper never retries a Turn itself.
      expect(f.rpc).toHaveBeenCalledOnce();
      await f.manager.sendRequest("turn/start", params);
      expect(f.createFileAttachment).toHaveBeenCalledOnce();
    } finally {
      f.dispose();
    }
  });

  it("checks the connection again before dispatching a cached preparation", async () => {
    const f = fixture();
    const params = request();
    try {
      await f.manager.sendRequest("turn/start", params);
      const retry = f.manager.sendRequest("turn/start", params);
      f.retire();
      await expect(retry).rejects.toThrow("no longer available");
      expect(f.rpc).toHaveBeenCalledOnce();
      expect(f.createFileAttachment).toHaveBeenCalledOnce();
    } finally {
      f.dispose();
    }
  });

  it("uses only the captured remote Host, independent of other connections", async () => {
    const first = fixture("ssh:first");
    const second = fixture("ssh:second");
    try {
      await first.manager.sendRequest("turn/start", request());
      expect(first.createFileAttachment).toHaveBeenCalledOnce();
      expect(second.createFileAttachment).not.toHaveBeenCalled();
      expect(second.rpc).not.toHaveBeenCalled();
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it("preserves inherited RPC methods and the native storage method's receiver", async () => {
    class Manager {
      #host = "/remote";
      calls: unknown[][] = [];
      sendRequest(...args: unknown[]) {
        this.calls.push(args);
        return Promise.resolve({});
      }
      getConversation(id: string) {
        return { id, modelProvider: "codexhost" };
      }
      getTurnCoordinator() {
        return {};
      }
      startTurn() {
        return undefined;
      }
      steerTurn() {
        return undefined;
      }
      async createFileAttachment({ label }: { label: string }) {
        return { label, path: `${this.#host}/${label}`, fsPath: `${this.#host}/${label}` };
      }
    }
    const manager = new Manager();
    const route = { hostId: "ssh:remote", manager, policy: {} } as unknown as RendererHostRoute;
    const routing = { forHost: () => route } as unknown as RendererHostRouting;
    const clients = createRendererHostClients(() => routing);
    try {
      clients.forHost(route.hostId);
      expect(Object.hasOwn(manager, "sendRequest")).toBe(false);
      expect(Object.hasOwn(manager, "createFileAttachment")).toBe(false);
      await manager.sendRequest("turn/start", request());
      expect(JSON.stringify(manager.calls)).toContain("/remote/image-1.png");
    } finally {
      clients.dispose();
    }
    expect(Object.getPrototypeOf(manager)).toBe(Manager.prototype);
    expect(Object.hasOwn(manager, "sendRequest")).toBe(false);
  });

  it("fails rather than silently losing images when the native storage binding is absent", async () => {
    const f = fixture();
    Object.defineProperty(f.manager, "createFileAttachment", { value: undefined });
    try {
      await expect(f.manager.sendRequest("turn/start", request())).rejects.toThrow(
        "storage is unavailable",
      );
      expect(f.rpc).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });

  it("rejects malformed returned paths without sending a Turn", async () => {
    const f = fixture();
    f.createFileAttachment.mockResolvedValue({
      label: "image",
      path: "relative.png",
      fsPath: "relative.png",
    });
    try {
      await expect(f.manager.sendRequest("turn/start", request())).rejects.toThrow(
        "invalid remote attachment path",
      );
      expect(f.rpc).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });

  it.each([
    ["local", "codexhost"],
    ["ssh:remote", "openai"],
  ])("leaves %s / %s submissions byte-for-byte unchanged", async (hostId, provider) => {
    const f = fixture(hostId, provider);
    const params = request();
    try {
      await f.manager.sendRequest("turn/start", params);
      expect(f.rpc.mock.calls[0]?.[1]).toBe(params);
      expect(f.createFileAttachment).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });
});

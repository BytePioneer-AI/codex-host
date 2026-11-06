import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDelegationCli } from "../src/delegation-cli.js";
import { LocalPreviewManager, type LocalPageHandle } from "../src/local-preview.js";

function page(): LocalPageHandle & {
  show: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return { show: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
}

describe("local design preview", () => {
  let base: string;
  let workspace: string;
  let mockups: string;
  const managers: LocalPreviewManager[] = [];

  function manager(...args: ConstructorParameters<typeof LocalPreviewManager>) {
    const value = new LocalPreviewManager(...args);
    managers.push(value);
    return value;
  }

  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), "codexhost-preview-"));
    workspace = path.join(base, "repo");
    mockups = path.join(workspace, ".spec", "mockups");
    await mkdir(path.join(mockups, "assets"), { recursive: true });
    await writeFile(path.join(mockups, "index.html"), "<html><body><h1>Home</h1></body></html>");
    await writeFile(path.join(mockups, "assets", "app.css"), "h1 { color: red; }");
    await writeFile(path.join(base, "secret.txt"), "outside");
  });
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((value) => value.closeAll()));
    await rm(base, { recursive: true, force: true });
  });

  it("serves the file at the root with live reload, and its directory read-only", async () => {
    const opened = page();
    const opener = vi.fn(async () => opened);
    const previews = manager({ page: opener });
    const result = await previews.open({
      path: path.join(mockups, "index.html"),
      cwd: workspace,
      threadId: "t1",
    });
    expect(result).toMatchObject({ opened: "builtInBrowser", threadId: "t1" });
    // The page belongs to the calling Thread, not to whichever task is shown.
    expect(opener).toHaveBeenCalledWith(result.url, "t1");
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);
    expect(opened.show).toHaveBeenCalledOnce();

    const root = await fetch(result.url);
    const html = await root.text();
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("<h1>Home</h1>");
    expect(html.indexOf("EventSource")).toBeLessThan(html.indexOf("</body>"));

    const css = await fetch(new URL("assets/app.css", result.url));
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toBe("h1 { color: red; }");

    expect((await fetch(new URL("assets/app.css", result.url), { method: "POST" })).status).toBe(
      405,
    );
    expect((await fetch(new URL("assets/", result.url))).status).toBe(404);
  });

  it("serves nothing outside the file's directory", async () => {
    await symlink(path.join(base, "secret.txt"), path.join(mockups, "link.txt"));
    const previews = manager({ page: vi.fn(async () => page()) });
    const { url } = await previews.open({ path: path.join(mockups, "index.html"), cwd: workspace });
    for (const target of [
      "/../../../secret.txt",
      "/%2e%2e/%2e%2e/%2e%2e/secret.txt",
      "/link.txt",
      "/%00",
    ]) {
      const response = await fetch(`${url.slice(0, -1)}${target}`);
      expect(response.status, target).toBe(404);
    }
  });

  it("refuses files outside the working directory, links that leave it, and missing files", async () => {
    await symlink(path.join(base, "secret.txt"), path.join(workspace, "escape.html"));
    const previews = manager({ page: vi.fn(async () => page()) });
    for (const target of [
      path.join(base, "secret.txt"),
      path.join(workspace, "escape.html"),
      path.join(workspace, "missing.html"),
    ])
      await expect(previews.open({ path: target, cwd: workspace }), target).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    await expect(previews.open({ path: mockups, cwd: workspace })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    // Outside the workspace, existing or not, the answer is the same.
    for (const target of [path.join(base, "secret.txt"), path.join(base, "absent.txt")])
      await expect(previews.open({ path: target, cwd: workspace })).rejects.toMatchObject({
        message: "Preview file must be inside the Thread's working directory",
      });
  });

  it("reloads open pages once after a burst of edits", async () => {
    const previews = manager({ page: vi.fn(async () => page()) });
    const { url } = await previews.open({ path: path.join(mockups, "index.html"), cwd: workspace });
    const response = await fetch(new URL("__codexhost_preview/reload", url));
    const reader = response.body?.getReader();
    if (!reader) throw new Error("no stream");
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value);
    await writeFile(path.join(mockups, "index.html"), "<html><body>v2</body></html>");
    await writeFile(path.join(mockups, "assets", "app.css"), "h1 { color: blue; }");
    const deadline = Date.now() + 3_000;
    while (!text.includes("data: reload") && Date.now() < deadline)
      text += decoder.decode((await reader.read()).value);
    expect(text.match(/data: reload/gu)).toHaveLength(1);
    await reader.cancel();
  });

  it("reuses an open preview, reopens a closed tab, and falls back to the system browser", async () => {
    const first = page();
    const second = page();
    const opener = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const browser = vi.fn(async () => undefined);
    const previews = manager({ page: opener, browser });
    const file = path.join(mockups, "index.html");
    const opened = await previews.open({ path: file, cwd: workspace });
    await expect(previews.open({ path: file, cwd: workspace })).resolves.toMatchObject({
      previewId: opened.previewId,
      opened: "builtInBrowser",
    });
    expect(opener).toHaveBeenCalledOnce();

    first.show.mockRejectedValueOnce(new Error("tab closed"));
    await expect(previews.show(opened.previewId)).resolves.toMatchObject({
      opened: "builtInBrowser",
    });
    expect(opener).toHaveBeenCalledTimes(2);

    opener.mockRejectedValue(new Error("no visible local task"));
    second.show.mockRejectedValue(new Error("tab closed"));
    await expect(previews.show(opened.previewId)).resolves.toMatchObject({
      opened: "systemBrowser",
      reason: "no visible local task",
    });
    expect(browser).toHaveBeenCalledWith(new URL(opened.url));
  });

  it("reports UNSUPPORTED where no page can be opened", async () => {
    await expect(
      manager({}).open({ path: path.join(mockups, "index.html"), cwd: workspace }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  it("closes previews on request, with their Thread, and beyond the limit", async () => {
    const pages = [page(), page(), page()];
    let index = 0;
    const previews = manager(
      { page: vi.fn(async () => pages[index++] ?? page()) },
      { maxPreviews: 2 },
    );
    await writeFile(path.join(mockups, "b.html"), "b");
    await writeFile(path.join(mockups, "c.html"), "c");
    const a = await previews.open({
      path: path.join(mockups, "index.html"),
      cwd: workspace,
      threadId: "t1",
    });
    const b = await previews.open({
      path: path.join(mockups, "b.html"),
      cwd: workspace,
      threadId: "t2",
    });
    await previews.open({ path: path.join(mockups, "c.html"), cwd: workspace, threadId: "t2" });
    // The least recently used preview made room for the third.
    expect(previews.list().previews.map((entry) => entry.path)).not.toContain(a.path);
    expect(pages[0]?.close).toHaveBeenCalled();
    await expect(fetch(a.url)).rejects.toThrow();

    await previews.closeThread("t2");
    expect(previews.list()).toEqual({ previews: [] });
    await expect(fetch(b.url)).rejects.toThrow();
    await expect(previews.close(b.previewId)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("sends the absolute file, the caller's cwd and Thread from the CLI", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"previewId":"p"}', { status: 200 }));
    const output = new PassThrough();
    await expect(
      runDelegationCli({
        arguments: ["preview", "open", "index.html"],
        environment: {
          CODEXHOST_RUNTIME_ENDPOINT: "http://127.0.0.1:1",
          CODEXHOST_RUNTIME_TOKEN: "t",
          CODEXHOST_THREAD_ID: "thread-1",
        },
        output,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBe(0);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/v1/preview/open");
    expect(JSON.parse(String(init.body))).toEqual({
      path: path.resolve(process.cwd(), "index.html"),
      cwd: process.cwd(),
      threadId: "thread-1",
    });
  });
});

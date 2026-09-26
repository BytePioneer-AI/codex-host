import { mkdtemp, mkdir, writeFile, rm, appendFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceTransport, ZCODE_SOURCE_REVISION } from "../src/transport.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(source: string) {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-transport-"));
  roots.push(root);
  await mkdir(path.join(root, "agent/provider"), { recursive: true });
  await writeFile(path.join(root, "agent/zcode.cjs"), "");
  await writeFile(path.join(root, "agent/provider/zcode-builtin.json"), "{}");
  await writeFile(
    path.join(root, "runtime.json"),
    JSON.stringify({
      formatVersion: 1,
      sourceRevision: ZCODE_SOURCE_REVISION,
      entry: "worker.cjs",
      agent: "agent/zcode.cjs",
      providerConfig: "agent/provider/zcode-builtin.json",
    }),
  );
  await writeFile(
    path.join(root, "worker.cjs"),
    `const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const {id,method,params}=JSON.parse(line);const send=result=>process.stdout.write(JSON.stringify({id,result})+'\\n');if(method==='initialize')send({protocol:1,sourceRevision:${JSON.stringify(ZCODE_SOURCE_REVISION)}});else{${source}}});`,
  );
  return root;
}
describe("ZCode owned local service transport", () => {
  it("shows only the interactive request and closes its owned page", async () => {
    const root = await fixture("process.stdout.write(JSON.stringify(params)+'\\n');send(null)");
    const page = { show: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const transport = new ServiceTransport({
      cwd: root,
      environment: {},
      runtimeDirectory: root,
      openLocalPage: async () => page,
    });
    const requestId = "12345678901234567890123456789012";
    try {
      await transport.start();
      await transport.request("emit", {
        event: "verification.required",
        requestId,
        url: `http://127.0.0.1:12345/?token=${requestId}`,
      });
      expect(page.show).not.toHaveBeenCalled();
      await transport.request("emit", { event: "verification.interactive", requestId });
      await vi.waitFor(() => expect(page.show).toHaveBeenCalledOnce());
      await transport.request("emit", { event: "verification.closed", requestId });
      await vi.waitFor(() => expect(page.close).toHaveBeenCalledOnce());
      await transport.close();
      expect(page.close).toHaveBeenCalledOnce();
    } finally {
      await transport.close();
    }
  });
  it("does not show a page that finishes opening after its verification was cancelled", async () => {
    const root = await fixture("process.stdout.write(JSON.stringify(params)+'\\n');send(null)");
    const page = { show: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const opening = Promise.withResolvers<typeof page>();
    const transport = new ServiceTransport({
      cwd: root,
      environment: {},
      runtimeDirectory: root,
      openLocalPage: () => opening.promise,
    });
    const requestId = "12345678901234567890123456789012";
    try {
      await transport.start();
      await transport.request("emit", {
        event: "verification.required",
        requestId,
        url: `http://127.0.0.1:12345/?token=${requestId}`,
      });
      await transport.request("emit", { event: "verification.interactive", requestId });
      await transport.request("emit", { event: "verification.closed", requestId });
      opening.resolve(page);
      await vi.waitFor(() => expect(page.close).toHaveBeenCalledOnce());
      expect(page.show).not.toHaveBeenCalled();
    } finally {
      opening.resolve(page);
      await transport.close();
    }
  });
  it.each([
    ["http://127.0.0.1:12345/?token=12345678901234567890123456789012", true],
    ["http://127.0.0.1:12345/12345678901234567890123456789012", false],
    ["http://example.com:12345/?token=12345678901234567890123456789012", false],
    ["http://127.0.0.1:12345/?token=12345678901234567890123456789012#fragment", false],
    ["http://127.0.0.1:12345/?token=short", false],
  ])("validates the verification URL before opening %s", async (url, accepted) => {
    const root = await fixture(
      `process.stdout.write(JSON.stringify({event:'verification.required',requestId:'12345678901234567890123456789012',url:${JSON.stringify(url)}})+'\\n');send(null)`,
    );
    const openLocalPage = vi.fn(async () => ({
      show: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    }));
    const transport = new ServiceTransport({
      cwd: root,
      environment: {},
      runtimeDirectory: root,
      openLocalPage,
    });
    try {
      await transport.start();
      if (accepted) {
        await transport.request("verify");
        expect(openLocalPage).toHaveBeenCalledExactlyOnceWith(url);
      } else {
        await expect(transport.request("verify")).rejects.toMatchObject({ code: "protocolError" });
        expect(openLocalPage).not.toHaveBeenCalled();
      }
    } finally {
      await transport.close();
    }
  });
  it("does not open a late verification page after the Session closes", async () => {
    const root = await fixture("send(null)");
    await appendFile(
      path.join(root, "worker.cjs"),
      `process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({event:'verification.required',url:'http://127.0.0.1:12345/?token=12345678901234567890123456789012'})+'\\n');setTimeout(()=>process.exit(0),10)});`,
    );
    const openLocalPage = vi.fn(async () => ({
      show: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    }));
    const transport = new ServiceTransport({
      cwd: root,
      environment: {},
      runtimeDirectory: root,
      openLocalPage,
    });
    await transport.start();
    await transport.close();
    expect(openLocalPage).not.toHaveBeenCalled();
  });
  it("does not start an unpinned runtime", async () => {
    const root = await fixture("send(null)");
    await writeFile(path.join(root, "runtime.json"), "{}");
    const transport = new ServiceTransport({ cwd: root, environment: {}, runtimeDirectory: root });
    await expect(transport.start()).rejects.toMatchObject({ code: "unsupported" });
    await transport.close();
  });
  it("passes the Thread environment into its child and closes independently", async () => {
    const root = await fixture("send({marker:process.env.CODEXHOST_THREAD_ID})");
    const one = new ServiceTransport({
      cwd: root,
      environment: { CODEXHOST_THREAD_ID: "one" },
      runtimeDirectory: root,
    });
    const two = new ServiceTransport({
      cwd: root,
      environment: { CODEXHOST_THREAD_ID: "two" },
      runtimeDirectory: root,
    });
    try {
      await Promise.all([one.start(), two.start()]);
      expect(await one.request("probe")).toEqual({ marker: "one" });
      await one.close();
      expect(await two.request("probe")).toEqual({ marker: "two" });
    } finally {
      await Promise.all([one.close(), two.close()]);
    }
  });
  it("fails a timed-out connection instead of accepting a late result", async () => {
    const root = await fixture("if(method!=='hang')send(null)");
    const transport = new ServiceTransport({
      cwd: root,
      environment: {},
      runtimeDirectory: root,
      timeoutMs: 100,
    });
    try {
      await transport.start();
      await expect(transport.request("hang")).rejects.toMatchObject({ code: "unavailable" });
      await expect(transport.request("probe")).rejects.toMatchObject({ code: "unavailable" });
    } finally {
      await transport.close();
    }
  });
});

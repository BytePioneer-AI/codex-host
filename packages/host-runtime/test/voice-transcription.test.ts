import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import type * as Fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { voiceStatus, transcribeVoice } from "../src/voice-transcription.js";
import {
  ClientChannelHost,
  type ClientChannelHostDependencies,
} from "../src/client-channel-host.js";
import { ClientChannelEvents } from "../src/client-channel-events.js";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof Fs>();
  return { ...fs, readFile: vi.fn(fs.readFile) };
});
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function setup(exp = 2_000_000_000) {
  const dir = await mkdtemp(join(tmpdir(), "voice-host-"));
  dirs.push(dir);
  const token = `header.${Buffer.from(
    JSON.stringify({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      exp,
      "https://api.openai.com/auth": { chatgpt_account_id: "private-account" },
    }),
  ).toString("base64url")}.secret-signature`;
  const auth = join(dir, "auth.json");
  await writeFile(
    auth,
    JSON.stringify({
      tokens: {
        access_token: token,
        refresh_token: "private-refresh",
        account_id: "private-account",
      },
    }),
  );
  const audio = join(dir, "voice.webm");
  await writeFile(audio, "audio");
  return {
    env: { CODEX_HOME: dir },
    auth,
    token,
    params: { path: audio, mimeType: "audio/webm;codecs=opus" },
  };
}

it("hides missing/API-key/invalid identities and rereads each request without caching", async () => {
  const { env, auth, params } = await setup();
  expect(await voiceStatus(env)).toEqual({ available: true });
  for (const body of ['{"OPENAI_API_KEY":"private-key"}', "{}", '{"tokens":{}}', "broken"]) {
    await writeFile(auth, body);
    expect(await voiceStatus(env)).toEqual({ available: false });
  }
  await rm(auth);
  expect(await voiceStatus(env)).toEqual({ available: false });
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect(await transcribeVoice(params, env)).toMatchObject({
    error: { code: "credentials-unavailable" },
  });
  expect(fetcher).not.toHaveBeenCalled();
});

it("retries a read/parse failure once but not a valid API-key configuration", async () => {
  const { env } = await setup();
  const read = vi.mocked(readFile);
  read.mockClear();
  read.mockResolvedValueOnce("partially written JSON");
  expect(await voiceStatus(env)).toEqual({ available: true });
  expect(read).toHaveBeenCalledTimes(2);
  read.mockClear();
  read.mockRejectedValueOnce(new Error("private-refresh"));
  expect(await voiceStatus(env)).toEqual({ available: true });
  expect(read).toHaveBeenCalledTimes(2);
  read.mockClear();
  read.mockResolvedValueOnce('{"OPENAI_API_KEY":"private-key"}');
  expect(await voiceStatus(env)).toEqual({ available: false });
  expect(read).toHaveBeenCalledTimes(1);
});

it("keeps expired credentials visible but reports login expiry without a network call or write", async () => {
  const { env, auth, params, token } = await setup(1);
  const before = await stat(auth);
  const contents = await readFile(auth, "utf8");
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect(await voiceStatus(env)).toEqual({ available: true });
  const result = await transcribeVoice(params, env);
  expect(result).toMatchObject({ ok: false, error: { code: "login-expired" } });
  expect(JSON.stringify(result)).not.toContain(token);
  expect(fetcher).not.toHaveBeenCalled();
  expect(await readFile(auth, "utf8")).toBe(contents);
  expect((await stat(auth)).mtimeMs).toBe(before.mtimeMs);
});

it.each([
  [200, { text: "你好" }, undefined],
  [401, null, "login-expired"],
  [429, null, "rate-limited"],
  [403, null, "service-rejected"],
  [415, null, "audio-format"],
  [200, { text: " " }, "audio-empty"],
  [200, {}, "service-rejected"],
])("handles upstream %s safely with one request", async (status, body, code) => {
  const { env, auth, params, token } = await setup();
  const before = await stat(auth);
  const contents = await readFile(auth, "utf8");
  const fetcher = vi.fn(
    async () => new Response(JSON.stringify(body ?? { error: token }), { status }),
  );
  vi.stubGlobal("fetch", fetcher);
  const result = await transcribeVoice(params, env);
  expect(result).toMatchObject(code ? { ok: false, error: { code } } : { ok: true, text: "你好" });
  expect(JSON.stringify(result)).not.toMatch(/secret-signature|private-refresh|private-account/);
  expect(fetcher).toHaveBeenCalledOnce();
  const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://chatgpt.com/backend-api/transcribe");
  expect(options.redirect).toBe("error");
  expect(options.headers).toMatchObject({
    Authorization: `Bearer ${token}`,
    originator: "Codex Desktop",
    "ChatGPT-Account-Id": "private-account",
  });
  expect((options.body as FormData).get("file")).toBeInstanceOf(Blob);
  expect(await readFile(auth, "utf8")).toBe(contents);
  expect((await stat(auth)).mtimeMs).toBe(before.mtimeMs);
});

it("preserves nonempty transcription text verbatim", async () => {
  const { env, params } = await setup();
  const text = " 你好，世界。\n保留换行。 ";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ text })),
  );
  expect(await transcribeVoice(params, env)).toEqual({ ok: true, text });
});

it("reports timeout/network errors without forwarding exception contents or retrying", async () => {
  const { env, params } = await setup();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("private-refresh");
    }),
  );
  expect(await transcribeVoice(params, env)).toMatchObject({ error: { code: "network" } });
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
  expect(await transcribeVoice(params, env)).toMatchObject({ error: { code: "timeout" } });
  expect(timeout).toHaveBeenCalledWith(90_000);
});

it("rejects empty, oversized, non-file and non-audio input before sending", async () => {
  const { env, params } = await setup();
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await writeFile(params.path, "");
  expect(await transcribeVoice(params, env)).toMatchObject({ error: { code: "audio-empty" } });
  await writeFile(params.path, Buffer.alloc(10 * 1024 * 1024 + 1));
  expect(await transcribeVoice(params, env)).toMatchObject({ error: { code: "audio-too-large" } });
  expect(await transcribeVoice({ ...params, path: env.CODEX_HOME }, env)).toMatchObject({
    error: { code: "audio-invalid" },
  });
  expect(await transcribeVoice({ ...params, mimeType: "text/plain" }, env)).toMatchObject({
    error: { code: "audio-format" },
  });
  expect(fetcher).not.toHaveBeenCalled();
});

it("handles voice methods on the client owner without submitting to Codex or waiting for plugins", async () => {
  const { env, params } = await setup();
  const submit = vi.fn();
  const waitForPlugins = vi.fn();
  const host = new ClientChannelHost({
    environment: () => env,
    events: new ClientChannelEvents(),
    submit,
    waitForPlugins,
  } as unknown as ClientChannelHostDependencies);
  expect(await host.handleClientRequest("codexhost/voice/status", {})).toEqual({
    result: { available: true },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ text: "hello" })),
  );
  expect(await host.handleClientRequest("codexhost/voice/transcribe", params)).toEqual({
    result: { ok: true, text: "hello" },
  });
  expect(submit).not.toHaveBeenCalled();
  expect(waitForPlugins).not.toHaveBeenCalled();
});

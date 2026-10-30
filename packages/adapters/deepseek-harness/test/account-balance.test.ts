import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  DeepSeekBalanceCache,
  DEEPSEEK_BALANCE_ENDPOINT,
  fetchDeepSeekBalances,
  projectDeepSeekBalances,
  readCredentialRef,
  readDeepSeekApiKey,
} from "../src/account-balance.js";
import { DeepSeekHarnessAdapter } from "../src/deepseek-harness-adapter.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "dsh-balance-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const CREDENTIALS = [
  "version: 1",
  "refs:",
  "  OTHER_KEY: nope",
  '  DEEPSEEK_API_KEY: "sk-from-file"',
  "records:",
  "  deepseek-account-platform/default:",
  "    kind: grant",
  "    payload:",
  "      DEEPSEEK_API_KEY: sk-nested-not-a-ref",
  "",
].join("\n");

it("reads only the top-level refs entry of the credentials document", () => {
  expect(readCredentialRef(CREDENTIALS, "DEEPSEEK_API_KEY")).toBe("sk-from-file");
  expect(
    readCredentialRef("version: 1\nrecords:\n  DEEPSEEK_API_KEY: x\n", "DEEPSEEK_API_KEY"),
  ).toBeUndefined();
  expect(readCredentialRef("DEEPSEEK_API_KEY: sk-flat\n", "DEEPSEEK_API_KEY")).toBe("sk-flat");
});

it("ignores YAML end-of-line comments around the refs entry", () => {
  const refs = (entry: string) =>
    readCredentialRef(`version: 1\nrefs:\n  ${entry}\n`, "DEEPSEEK_API_KEY");
  expect(
    readCredentialRef(
      'version: 1\nrefs: # API keys\n  DEEPSEEK_API_KEY: "sk-quoted" # primary\n',
      "DEEPSEEK_API_KEY",
    ),
  ).toBe("sk-quoted");
  expect(refs("DEEPSEEK_API_KEY: 'sk-single' # note")).toBe("sk-single");
  expect(refs("DEEPSEEK_API_KEY: sk-bare # note")).toBe("sk-bare");
  // A value that is only a comment holds no key.
  expect(refs("DEEPSEEK_API_KEY: # unset")).toBeUndefined();
});

it("follows DSH precedence: credentials file, then environment, then .env", async () => {
  const environment = { DSH_HOME: home, DEEPSEEK_API_KEY: "sk-env" };
  await writeFile(path.join(home, ".env"), "DEEPSEEK_API_KEY=sk-dotenv\n");
  expect(await readDeepSeekApiKey(environment)).toBe("sk-env");
  expect(await readDeepSeekApiKey({ DSH_HOME: home })).toBe("sk-dotenv");
  await writeFile(path.join(home, ".credentials.yaml"), CREDENTIALS);
  expect(await readDeepSeekApiKey(environment)).toBe("sk-from-file");
});

it("projects funded currencies and keeps an exhausted key visible as zero", () => {
  expect(
    projectDeepSeekBalances({
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: "110.00", granted_balance: "10.00" },
        { currency: "USD", total_balance: "0.00" },
      ],
    }),
  ).toEqual([
    { label: "DeepSeek API", balance: { amount: 110, currency: "CNY", label: "DeepSeek API" } },
  ]);
  expect(
    projectDeepSeekBalances({
      balance_infos: [
        { currency: "CNY", total_balance: "1.5" },
        { currency: "USD", total_balance: "2" },
      ],
    }).map((account) => account.label),
  ).toEqual(["DeepSeek API (CNY)", "DeepSeek API (USD)"]);
  expect(
    projectDeepSeekBalances({
      is_available: false,
      balance_infos: [{ currency: "CNY", total_balance: "0.00" }],
    }),
  ).toEqual([
    { label: "DeepSeek API", balance: { amount: 0, currency: "CNY", label: "DeepSeek API" } },
  ]);
  expect(
    projectDeepSeekBalances({ balance_infos: [{ currency: "CNY", total_balance: "-1" }] }),
  ).toEqual([]);
  expect(projectDeepSeekBalances(null)).toEqual([]);
});

it("sends the key only to DeepSeek's balance endpoint and hides failures", async () => {
  const fetchMock = vi.fn(async () =>
    Response.json({ balance_infos: [{ currency: "CNY", total_balance: "3.20" }] }),
  );
  const accounts = await fetchDeepSeekBalances({
    readApiKey: async () => "sk-test",
    fetch: fetchMock as unknown as typeof fetch,
  });
  expect(accounts[0]?.balance).toEqual({ amount: 3.2, currency: "CNY", label: "DeepSeek API" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(DEEPSEEK_BALANCE_ENDPOINT);
  expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");

  const unauthorized = vi.fn(async () => new Response("{}", { status: 401 }));
  expect(
    await fetchDeepSeekBalances({
      readApiKey: async () => "sk-test",
      fetch: unauthorized as unknown as typeof fetch,
    }),
  ).toEqual([]);
  const neverCalled = vi.fn();
  expect(
    await fetchDeepSeekBalances({
      readApiKey: async () => undefined,
      fetch: neverCalled as unknown as typeof fetch,
    }),
  ).toEqual([]);
  expect(neverCalled).not.toHaveBeenCalled();
});

it("exposes the balance as Adapter account telemetry and stops after close", async () => {
  const adapter = new DeepSeekHarnessAdapter({ environment: { DSH_HOME: home } });
  expect(await adapter.inspectAccounts()).toEqual([]);
  expect(await adapter.inspectAccount()).toBeNull();
  expect(adapter.balance()).toBeNull();
  expect(await adapter.refreshBalance()).toBeNull();

  // The key DSH stores under DSH_HOME reaches the balance request.
  await writeFile(path.join(home, ".credentials.yaml"), CREDENTIALS);
  const fetchMock = vi.fn(async () =>
    Response.json({ balance_infos: [{ currency: "CNY", total_balance: "8.80" }] }),
  );
  vi.stubGlobal("fetch", fetchMock);
  try {
    const account = {
      label: "DeepSeek API",
      balance: { amount: 8.8, currency: "CNY", label: "DeepSeek API" },
    };
    expect(await adapter.inspectAccounts()).toEqual([account]);
    expect(await adapter.inspectAccount()).toEqual(account);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(DEEPSEEK_BALANCE_ENDPOINT);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-from-file");

    expect(adapter.balance()).toEqual(expect.objectContaining({ amount: 8.8, currency: "CNY" }));

    await adapter.close();
    expect(await adapter.inspectAccounts()).toEqual([]);
    expect(adapter.balance()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("aborts a balance request in flight at close and drops its late result", async () => {
  await writeFile(path.join(home, ".credentials.yaml"), CREDENTIALS);
  let answer: (() => void) | undefined;
  // The response arrives only after close, as if the request ignored the abort.
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    () =>
      new Promise<Response>((resolve) => {
        answer = () =>
          resolve(Response.json({ balance_infos: [{ currency: "CNY", total_balance: "8.80" }] }));
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  try {
    const adapter = new DeepSeekHarnessAdapter({ environment: { DSH_HOME: home } });
    const inspection = adapter.inspectAccounts();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const signal = fetchMock.mock.calls[0]?.[1].signal;
    expect(signal?.aborted).toBe(false);

    await adapter.close();
    expect(signal?.aborted).toBe(true);
    answer?.();
    expect(await inspection).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("caches the Composer balance, dedupes requests and throttles refreshes", async () => {
  let now = 0;
  let calls = 0;
  let amount = 5;
  const cache = new DeepSeekBalanceCache(
    async () => {
      calls += 1;
      return amount < 0 ? [] : [{ label: "DeepSeek API", balance: { amount, currency: "CNY" } }];
    },
    () => now,
    30_000,
  );
  expect(cache.read()).toBeNull();
  await Promise.all([cache.refresh(), cache.refresh()]);
  expect(calls).toBe(1);
  expect(cache.read()).toEqual({ amount: 5, currency: "CNY" });

  amount = 4;
  now = 10_000;
  await cache.refresh();
  expect(calls).toBe(1);
  expect(cache.read()?.amount).toBe(5);
  now = 31_000;
  await cache.refresh();
  expect(calls).toBe(2);
  expect(cache.read()?.amount).toBe(4);

  amount = -1;
  await cache.inspect();
  expect(cache.read()).toBeNull();

  amount = 3;
  await cache.inspect();
  cache.close();
  expect(cache.read()).toBeNull();
  expect(await cache.inspect()).toEqual([]);
});

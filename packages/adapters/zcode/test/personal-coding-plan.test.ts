import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountConfig, providerRuntimeHeaders } from "../src/account.js";
import { personalCodingPlanOrigin } from "../src/personal-coding-plan.js";
import type { ZcodeInstallation } from "../src/installation.js";

const SECRET = "coding-plan-fixture";
const KEY = "synthetic-personal-api-key";
const JWT = "synthetic-start-jwt";
const userId = "fixture:account/one";
const activeSubscription = { productId: "glm-coding-max", status: "VALID", inCurrentPeriod: true };
const id = (family: string) => `account:${family}-individual-coding-plan`;
const keyName = (family: string, user = userId) =>
  `account-provider:coding-plan:${id(family)}:account:${encodeURIComponent(user)}:api-key`;
function encrypted(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(SECRET).digest(), iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc:v1:${[iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".")}`;
}

describe("Personal Coding Plan read-only account integration", () => {
  let root: string, installation: ZcodeInstallation, environment: NodeJS.ProcessEnv;
  let credentials: Record<string, string>;
  const verifier = vi.fn(() => {
    throw new Error("Coding Plan must not request CAPTCHA");
  });
  async function saveCredentials() {
    await writeFile(
      path.join(installation.dataRoot, "credentials.json"),
      JSON.stringify(
        Object.fromEntries(
          Object.entries(credentials).map(([key, value]) => [key, encrypted(value)]),
        ),
      ),
    );
  }
  async function select(family: string, kind = "individual-coding-plan", home = root) {
    await mkdir(path.join(home, ".zcode/v2"), { recursive: true });
    await writeFile(
      path.join(home, ".zcode/v2/setting.json"),
      JSON.stringify({
        providerFamilyDomain: family,
        providerFamilyConnectionSelections: { [family]: { kind } },
      }),
    );
  }
  async function login(family: "zai" | "bigmodel", user = userId) {
    credentials = {
      "oauth:active_provider": family,
      [`oauth:${family}:user_info`]: JSON.stringify(
        family === "zai"
          ? { user_id: user, name: "Fixture" }
          : { id: user, username: "fixture", displayName: "Fixture" },
      ),
      [keyName(family, user)]: KEY,
      zcodejwttoken: JWT,
    };
    await saveCredentials();
    await select(family);
  }
  function request(family = "zai") {
    return {
      providerId: id(family),
      modelSelection: { providerId: id(family), modelId: "GLM-5.3" },
      accountAccess: { type: "zhipu-account", accountType: family, mode: "individual-coding-plan" },
    };
  }
  async function auth(
    config: Awaited<ReturnType<typeof accountConfig>>,
    input: Record<string, unknown> = request(),
    signal = new AbortController().signal,
  ) {
    return providerRuntimeHeaders(
      input,
      signal,
      installation,
      environment,
      verifier,
      config.codingPlan,
    );
  }
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zcode-coding-account-"));
    const dataRoot = path.join(root, ".zcode/v2");
    await mkdir(dataRoot, { recursive: true });
    installation = {
      runtime: "unused",
      version: "3.14.4",
      cli: "unused",
      dataRoot,
      builtinProviderConfig: path.join(root, "builtin.json"),
      personalProviderConfig: path.join(dataRoot, "provider_config.json"),
    };
    environment = { HOME: root, ZCODE_DATA_BASE_DIR: root, ZCODE_CREDENTIAL_SECRET: SECRET };
    await writeFile(
      installation.builtinProviderConfig,
      JSON.stringify({
        revision: 30,
        config: {
          providerConfigRules: {
            providerRules: ["zai", "bigmodel"].flatMap((family) =>
              ["start-plan", "individual-coding-plan", "team-coding-plan"].map((mode) => ({
                providerId: `account:${family}-${mode}`,
                config: {
                  builtinModelIds: ["GLM-5.3"],
                  access: { type: "zhipu-account", accountType: family, mode },
                },
              })),
            ),
          },
        },
      }),
    );
    await login("zai");
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ code: 0, data: [activeSubscription] })),
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    verifier.mockClear();
    await rm(root, { recursive: true, force: true });
  });

  it.each(["zai", "bigmodel"] as const)(
    "publishes %s entitlement, keeps builtin models, and uses the exact account key without CAPTCHA",
    async (family) => {
      await login(family);
      const before = await readFile(path.join(installation.dataRoot, "credentials.json"), "utf8");
      const config = await accountConfig(installation, environment);
      expect(config.params.providers[id(family)]).toEqual({
        access: { type: "zhipu-account", entitled: true },
      });
      expect(config.params.states[id(family)]).toMatchObject({
        availability: "available",
        entitled: true,
        current: true,
      });
      expect(config.params.providers[`account:${family}-team-coding-plan`]).toBeUndefined();
      expect(config.startPlan).toBe(false);
      expect(fetch).toHaveBeenCalledWith(
        `${personalCodingPlanOrigin(family, environment)}/api/biz/subscription/list`,
        expect.objectContaining({
          method: "GET",
          headers: { Authorization: KEY },
          redirect: "error",
        }),
      );
      expect(await auth(config, request(family))).toEqual({
        headersApplied: true,
        requestAuth: { apiKey: KEY },
      });
      expect(verifier).not.toHaveBeenCalled();
      expect(await readFile(path.join(installation.dataRoot, "credentials.json"), "utf8")).toBe(
        before,
      );
      expect(JSON.stringify(config.params)).not.toContain(KEY);
      expect(JSON.stringify(config.params)).not.toContain(userId);
    },
  );

  it.each([
    [[], "unavailable", "not-entitled"],
    [[{ ...activeSubscription, status: "EXPIRED" }], "unavailable", "not-entitled"],
    [[{ ...activeSubscription, inCurrentPeriod: false }], "unavailable", "not-entitled"],
    [[{ productName: "coding", status: "VALID" }], "unknown", undefined],
    [[null, { productName: "unrelated" }, activeSubscription], "available", undefined],
  ])(
    "classifies subscription data %j without inventing entitlement",
    async (data, availability, reason) => {
      vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ data })));
      const config = await accountConfig(installation, environment);
      expect(config.params.states[id("zai")]).toMatchObject({
        availability,
        entitled: availability === "available",
      });
      expect(
        (config.params.states[id("zai")] as { unavailableReason?: string }).unavailableReason,
      ).toBe(reason);
      expect((await auth(config)).headersApplied).toBe(availability === "available");
    },
  );

  it.each([401, 403, 500])("classifies HTTP %s without leaking the response", async (status) => {
    vi.mocked(fetch).mockResolvedValue(new Response(KEY, { status }));
    const config = await accountConfig(installation, environment);
    expect(config.params.states[id("zai")]).toMatchObject({
      availability: status === 500 ? "unknown" : "unavailable",
      entitled: false,
    });
    const result = await auth(config);
    expect(result.headersApplied).toBe(false);
    expect(JSON.stringify([config.params, result])).not.toContain(KEY);
  });

  it("fails closed on network errors or unsuccessful envelopes", async () => {
    for (const payload of [
      new Error(KEY),
      { code: 401, data: [activeSubscription] },
      { success: false, data: [activeSubscription] },
      { data: {} },
    ]) {
      vi.mocked(fetch).mockImplementation(async () => {
        if (payload instanceof Error) throw payload;
        return new Response(JSON.stringify(payload));
      });
      const config = await accountConfig(installation, environment);
      expect(config.params.states[id("zai")]).toMatchObject({
        availability: "unknown",
        entitled: false,
      });
      expect((await auth(config)).headersApplied).toBe(false);
    }
  });

  it("keeps Start and Personal Coding Plan independently entitled", async () => {
    await writeFile(
      path.join(installation.dataRoot, "telemetry-state.json"),
      JSON.stringify({ deviceMid: "fixture" }),
    );
    vi.mocked(fetch).mockImplementation(
      async (url) =>
        new Response(
          JSON.stringify({
            data: String(url).includes("/billing/balance")
              ? {
                  plans: [{ status: "active", plan_id: "start-plan" }],
                  balances: [{ capabilities: ["model:GLM-5.3"] }],
                }
              : [activeSubscription],
          }),
        ),
    );
    const config = await accountConfig(installation, environment);
    expect(config.startPlan).toBe(true);
    expect(config.params.states["account:zai-start-plan"]).toMatchObject({
      entitled: true,
      current: true,
    });
    expect(config.params.states[id("zai")]).toMatchObject({ entitled: true, current: true });
    expect(await auth(config)).toMatchObject({ requestAuth: { apiKey: KEY } });
    const file = path.join(installation.dataRoot, "credentials.json");
    const stored = JSON.parse(await readFile(file, "utf8"));
    stored.zcodejwttoken = "enc:v1:invalid";
    await writeFile(file, JSON.stringify(stored));
    const damagedStart = await accountConfig(installation, environment);
    expect(damagedStart.startPlan).toBe(false);
    expect((await auth(damagedStart)).headersApplied).toBe(true);
  });

  it("uses Desktop's normalized profile or raw Z.AI user_id, not an unrelated raw id", async () => {
    for (const profile of [
      { user_id: userId, id: "unrelated-id" },
      { id: userId, username: "fixture", displayName: "Fixture", user_id: "unrelated-id" },
    ]) {
      credentials["oauth:zai:user_info"] = JSON.stringify(profile);
      await saveCredentials();
      expect((await auth(await accountConfig(installation, environment))).headersApplied).toBe(
        true,
      );
    }
  });

  it("does not borrow another account's key, use JWT, or create a key when missing", async () => {
    credentials[keyName("zai", "other-account")] = KEY;
    Reflect.deleteProperty(credentials, keyName("zai"));
    await saveCredentials();
    const config = await accountConfig(installation, environment);
    expect(config.params.states[id("zai")]).toMatchObject({
      entitled: false,
      unavailableReason: "credential-failed",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect((await auth(config)).headersApplied).toBe(false);
  });

  it("isolates a malformed or undecryptable personal credential from Start Plan", async () => {
    await writeFile(
      path.join(installation.dataRoot, "telemetry-state.json"),
      JSON.stringify({ deviceMid: "fixture" }),
    );
    vi.mocked(fetch).mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              plans: [{ status: "active", plan_id: "start-plan" }],
              balances: [{ capabilities: ["model:GLM-5.3"] }],
            },
          }),
        ),
    );
    for (const corrupt of ["bad-json", JSON.stringify({ user_id: userId })]) {
      credentials["oauth:zai:user_info"] = corrupt;
      credentials[keyName("zai")] = "enc:v1:invalid";
      await saveCredentials();
      const credentialFile = path.join(installation.dataRoot, "credentials.json");
      const stored = JSON.parse(await readFile(credentialFile, "utf8"));
      stored[keyName("zai")] = "enc:v1:invalid";
      await writeFile(credentialFile, JSON.stringify(stored));
      const config = await accountConfig(installation, environment);
      expect(config.startPlan).toBe(true);
      expect(config.params.states[id("zai")]).toMatchObject({ entitled: false });
    }
  });

  it("honors Desktop settings home separately from credential home and reads legacy selections", async () => {
    const desktopHome = path.join(root, "desktop");
    environment.ZCODE_DESKTOP_HOME_DIR = desktopHome;
    await select("zai", "individual-coding-plan", desktopHome);
    await select("zai", "start-plan");
    expect((await auth(await accountConfig(installation, environment))).headersApplied).toBe(true);
    await writeFile(
      path.join(desktopHome, ".zcode/v2/setting.json"),
      JSON.stringify({
        providerFamilyDomain: "zai",
        modelProviderFamilyModes: { zai: "account" },
        modelProviderFamilySelectedKeys: { zai: "coding-plan:builtin:zai-coding-plan" },
      }),
    );
    expect((await auth(await accountConfig(installation, environment))).headersApplied).toBe(true);
  });

  it("keeps entitlement distinct from current selection, and never overrides an explicit new selection", async () => {
    await select("zai", "team-coding-plan");
    const config = await accountConfig(installation, environment);
    expect(config.params.states[id("zai")]).toMatchObject({ entitled: true, current: false });
    expect((await auth(config)).headersApplied).toBe(false);
    await writeFile(
      path.join(root, ".zcode/v2/setting.json"),
      JSON.stringify({
        providerFamilyDomain: "zai",
        providerFamilyConnectionSelections: {},
        modelProviderFamilySelectedKeys: { zai: "coding-plan:builtin:zai-coding-plan" },
      }),
    );
    expect((await auth(await accountConfig(installation, environment))).headersApplied).toBe(false);
  });

  it("rejects changed identity, selection and logout on an already open transport", async () => {
    const config = await accountConfig(installation, environment);
    await select("zai", "start-plan");
    expect((await auth(config)).headersApplied).toBe(false);
    await login("zai", "different-user");
    expect((await auth(config)).headersApplied).toBe(false);
    const changed = await accountConfig(installation, environment);
    expect(changed.params.revision).not.toBe(config.params.revision);
    expect((await auth(changed)).headersApplied).toBe(true);
    credentials["oauth:active_provider"] = "bigmodel";
    await saveCredentials();
    expect((await auth(changed)).headersApplied).toBe(false);
    credentials = {};
    await saveCredentials();
    expect((await auth(changed)).headersApplied).toBe(false);
  });

  it("discards a query that crossed an account change", async () => {
    vi.mocked(fetch).mockImplementation(async () => {
      await login("zai", "new-user");
      return new Response(JSON.stringify({ data: [activeSubscription] }));
    });
    const config = await accountConfig(installation, environment);
    expect(config.params.states[id("zai")]).toMatchObject({
      availability: "unknown",
      entitled: false,
      current: false,
    });
    expect((await auth(config)).headersApplied).toBe(false);
  });

  it("validates provider/family/model consistency and cancellation before exposing a key", async () => {
    const config = await accountConfig(installation, environment);
    for (const input of [
      request("bigmodel"),
      { ...request(), providerId: "unknown" },
      { ...request(), modelSelection: { providerId: "other" } },
      { ...request(), accountAccess: { ...request().accountAccess, accountType: "bigmodel" } },
      { ...request(), accountAccess: { mode: "team-coding-plan" } },
    ]) {
      const result = await auth(config, input);
      expect(result.headersApplied).toBe(false);
      expect(JSON.stringify(result)).not.toContain(KEY);
    }
    expect((await auth(config, request(), AbortSignal.abort())).headersApplied).toBe(false);
  });

  it("resolves native business origins without borrowing the Start endpoint", () => {
    expect(personalCodingPlanOrigin("zai", { ZCODE_BASE_URL: "https://wrong.invalid" })).toBe(
      "https://api.z.ai",
    );
    expect(personalCodingPlanOrigin("bigmodel", { ZCODE_ENV: "test" })).toBe(
      "https://dev.bigmodel.cn",
    );
    expect(
      personalCodingPlanOrigin("zai", {
        ZCODE_ENV: "test",
        ZAI_TEST_BUSINESS_BASE_URL: "http://localhost:123/path",
      }),
    ).toBe("http://localhost:123");
    expect(
      personalCodingPlanOrigin("bigmodel", {
        BIGMODEL_API_BASE_URL: "http://localhost:123",
        BIGMODEL_PRODUCTION_API_BASE_URL: "https://ignored.invalid",
      }),
    ).toBe("http://localhost:123");
  });
});

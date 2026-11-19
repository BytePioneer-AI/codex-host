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

  const LOGIN = "synthetic-oauth-login";
  const TOKEN = "synthetic-project-token";
  const location = { organizationId: "org/one", projectId: "project/one", apiKeyId: "key/one" };
  it.each(
    ["start-plan", "individual-coding-plan"].flatMap((selection) =>
      ["missing-key", "no-subscription", "unreadable-profile"].map((failure) => ({
        selection,
        failure,
      })),
    ),
  )(
    "keeps $failure diagnostics scoped to the $selection selection",
    async ({ selection, failure }) => {
      await select("zai", selection);
      if (failure === "missing-key") Reflect.deleteProperty(credentials, keyName("zai"));
      if (failure === "unreadable-profile") credentials["oauth:zai:user_info"] = "invalid-json";
      await saveCredentials();
      if (failure === "no-subscription")
        vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ data: [] })));
      const config = await accountConfig(installation, environment);
      expect(config.params.states[id("zai")]).toMatchObject({ entitled: false });
      if (selection === "individual-coding-plan")
        expect(config.codingPlan.issue).toContain("Personal Coding Plan");
      else expect(config.codingPlan.issue).toBeUndefined();
    },
  );
  function locationKey(family: string, user = userId) {
    return `project-key-location:v1:${encodeURIComponent(
      JSON.stringify([
        personalCodingPlanOrigin(family as "zai" | "bigmodel", environment),
        family,
        user,
        null,
        1,
        "non-team",
      ]),
    )}`;
  }
  async function projectLogin(family: "zai" | "bigmodel" = "bigmodel") {
    await login(family);
    Reflect.deleteProperty(credentials, keyName(family));
    credentials[`oauth:${family}:access_token`] = LOGIN;
    credentials[locationKey(family)] = JSON.stringify(location);
    await saveCredentials();
    installation.version = "3.16.3";
    vi.mocked(fetch).mockImplementation(
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).endsWith("/access_tokens")
              ? {
                  code: 200,
                  data: {
                    accessToken: TOKEN,
                    tokenType: "Bearer",
                    expiresIn: 3600,
                    expiresAt: Date.now() / 1000 + 3600,
                  },
                }
              : { code: 200, data: [activeSubscription] },
          ),
        ),
    );
  }

  it.each(["before", "during"])(
    "returns no authentication diagnostic when cancelled %s token exchange",
    async (when) => {
      await projectLogin();
      const config = await accountConfig(installation, environment);
      const controller = new AbortController();
      const reason = new Error(LOGIN);
      vi.mocked(fetch)
        .mockClear()
        .mockImplementation(async () => {
          controller.abort(reason);
          throw reason;
        });
      if (when === "before") controller.abort(reason);
      expect(await auth(config, request("bigmodel"), controller.signal)).toEqual({
        headersApplied: false,
      });
      expect(fetch).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
    },
  );

  it.each(["zai", "bigmodel"] as const)(
    "recognizes %s project credentials and authenticates without a legacy key",
    async (family) => {
      await projectLogin(family);
      const before = await readFile(path.join(installation.dataRoot, "credentials.json"), "utf8");
      const config = await accountConfig(installation, environment);
      expect(config.params.states[id(family)]).toMatchObject({
        availability: "available",
        entitled: true,
        current: true,
      });
      expect(fetch).toHaveBeenCalledWith(
        `${personalCodingPlanOrigin(family, environment)}/api/biz/subscription/list`,
        expect.objectContaining({ headers: { Authorization: LOGIN } }),
      );
      expect(
        vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/access_tokens")),
      ).toBe(false);
      const result = await auth(config, request(family));
      expect(result).toMatchObject({
        headersApplied: true,
        requestAuth: { apiKey: TOKEN, apiKeyId: location.apiKeyId },
      });
      expect(fetch).toHaveBeenCalledWith(
        `${personalCodingPlanOrigin(family, environment)}/api/biz/v1/organization/org%2Fone/projects/project%2Fone/api_keys/key%2Fone/access_tokens`,
        expect.objectContaining({
          method: "POST",
          headers: { Authorization: `Bearer ${LOGIN}`, "Content-Type": "application/json" },
          redirect: "error",
        }),
      );
      expect(JSON.stringify(config.params)).not.toContain(LOGIN);
      expect(JSON.stringify(config.params)).not.toContain(TOKEN);
      expect(await readFile(path.join(installation.dataRoot, "credentials.json"), "utf8")).toBe(
        before,
      );
      expect(verifier).not.toHaveBeenCalled();
    },
  );

  it("reuses valid project tokens and renews a rejected token only in the same account scope", async () => {
    await projectLogin();
    const config = await accountConfig(installation, environment);
    const first = await auth(config, request("bigmodel"));
    expect(first).toMatchObject({ headersApplied: true });
    if (!first.headersApplied || !first.requestAuth || !("accountScope" in first.requestAuth))
      throw new Error("missing scope");
    const scope = first.requestAuth.accountScope;
    await auth(config, request("bigmodel"));
    const tokenCalls = () =>
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/access_tokens"));
    expect(tokenCalls()).toHaveLength(1);
    expect(
      (await auth(config, { ...request("bigmodel"), expectedAccountScope: "wrong-scope" }))
        .headersApplied,
    ).toBe(false);
    expect(tokenCalls()).toHaveLength(1);
    await auth(config, {
      ...request("bigmodel"),
      expectedAccountScope: scope,
      rejectedProjectTokenFingerprint: createHash("sha256").update(TOKEN).digest("hex"),
    });
    expect(tokenCalls()).toHaveLength(2);
  });

  it.each(["identity", "selection", "login", "location"])(
    "discards project token results crossing a %s change",
    async (change) => {
      await projectLogin();
      const config = await accountConfig(installation, environment);
      vi.mocked(fetch).mockImplementation(async () => {
        if (change === "identity") await login("bigmodel", "another-user");
        if (change === "selection") await select("bigmodel", "team-coding-plan");
        if (change === "login") {
          credentials["oauth:bigmodel:access_token"] = "new-login";
          await saveCredentials();
        }
        if (change === "location") {
          credentials[locationKey("bigmodel")] = JSON.stringify({
            ...location,
            projectId: "other",
          });
          await saveCredentials();
        }
        return new Response(
          JSON.stringify({
            code: 200,
            data: {
              accessToken: TOKEN,
              tokenType: "Bearer",
              expiresIn: 3600,
              expiresAt: Date.now() / 1000 + 3600,
            },
          }),
        );
      });
      const result = await auth(config, request("bigmodel"));
      expect(result.headersApplied).toBe(false);
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    },
  );

  it("never borrows a project locator belonging to another account", async () => {
    await projectLogin();
    credentials[locationKey("bigmodel", "other-user")] = JSON.stringify(location);
    Reflect.deleteProperty(credentials, locationKey("bigmodel"));
    await saveCredentials();
    const config = await accountConfig(installation, environment);
    expect(config.params.states[id("bigmodel")]).toMatchObject({ entitled: false });
    expect(fetch).not.toHaveBeenCalled();
  });

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

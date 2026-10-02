import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountConfig, resolveEndpointOrigin } from "../src/account.js";
import type { ZcodeInstallation } from "../src/installation.js";

const SECRET = "fixture-only";
const JWT = "synthetic.jwt.value";
const DEVICE_MID = "fixture-device-mid";

function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(SECRET).digest(), iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc:v1:${[iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".")}`;
}

const builtin = {
  schemaVersion: 1,
  revision: 30,
  config: {
    providerConfigRules: {
      providerRules: [
        {
          providerId: "account:zai-start-plan",
          config: {
            builtinModelIds: ["GLM-5.3", "GLM-5.3-Flash", "GLM-5.2"],
            access: { type: "zhipu-account", mode: "start-plan", accountType: "zai" },
          },
        },
      ],
    },
    modelConfigRules: {},
  },
};

describe("ZCode account configuration and Start Plan entitlement", () => {
  let root: string;
  let installation: ZcodeInstallation;
  const env: NodeJS.ProcessEnv = {
    ZCODE_CREDENTIAL_SECRET: SECRET,
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zcode-account-test-"));
    const dataRoot = path.join(root, ".zcode", "v2");
    await mkdir(dataRoot, { recursive: true });
    const builtinPath = path.join(root, "zcode-builtin.json");
    await writeFile(builtinPath, JSON.stringify(builtin));
    await writeFile(
      path.join(dataRoot, "credentials.json"),
      JSON.stringify({
        "oauth:active_provider": encrypt("zai"),
        zcodejwttoken: encrypt(JWT),
      }),
    );
    await writeFile(
      path.join(dataRoot, "telemetry-state.json"),
      JSON.stringify({ deviceMid: DEVICE_MID }),
    );
    installation = {
      runtime: path.join(root, "ZCode Helper"),
      version: "9.9.9",
      cli: path.join(root, "zcode.cjs"),
      builtinProviderConfig: builtinPath,
      personalProviderConfig: path.join(dataRoot, "provider_config.json"),
      dataRoot,
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("entitled plan → only capability models, available, X-Device-Mid and Bearer sent", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            plans: [
              {
                plan_id: "zcode-v3-start-plan-trust-0930",
                name: "ZCode Trust Plan",
                status: "active",
              },
            ],
            balances: [
              {
                capabilities: ["model:glm-5.3-flash"],
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await accountConfig(installation, env);

    expect(capturedUrl).toContain("/api/v1/zcode-plan/billing/balance?app_version=9.9.9");
    expect(capturedHeaders?.Authorization).toBe(`Bearer ${JWT}`);
    expect(capturedHeaders?.["X-Device-Mid"]).toBe(DEVICE_MID);
    expect(result.startPlan).toBe(true);

    expect(result.params.providers["account:zai-start-plan"]).toEqual({
      builtinModelIds: ["GLM-5.3-Flash"],
      access: { type: "zhipu-account", entitled: true },
    });
    expect(result.params.states["account:zai-start-plan"]).toEqual({
      availability: "available",
      entitled: true,
      current: true,
    });
  });

  it("normalizes expired plans and drops their balances (past ends_at → not entitled)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            server_time: 1700000500,
            plans: [
              {
                plan_id: "zcode-v3-start-plan-trust",
                status: "active",
                ends_at: 1700000000, // in the past relative to server_time
              },
            ],
            balances: [
              {
                plan_id: "zcode-v3-start-plan-trust",
                capabilities: ["model:glm-5.3-flash"],
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await accountConfig(installation, env);
    expect(result.startPlan).toBe(false);
    expect(result.params.providers["account:zai-start-plan"]).toEqual({
      access: { type: "zhipu-account", entitled: false },
    });
    expect(result.params.states["account:zai-start-plan"]).toEqual({
      availability: "unavailable",
      entitled: false,
      unavailableReason: "not-entitled",
      current: true,
    });
  });

  it("normalizes capability model names against builtinModelIds and keeps unknown names as is", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            plans: [
              {
                plan_id: "zcode-v3-start-plan-trust",
                status: "active",
              },
            ],
            balances: [
              {
                capabilities: [
                  "model:glm-5.3", // matches builtinModelIds "GLM-5.3"
                  "model:GLM-5.2", // matches builtinModelIds "GLM-5.2"
                  "model:unknown-experimental-model", // not in builtinModelIds -> preserved
                ],
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await accountConfig(installation, env);
    expect(result.startPlan).toBe(true);
    expect(result.params.providers["account:zai-start-plan"]).toEqual({
      builtinModelIds: ["GLM-5.3", "GLM-5.2", "unknown-experimental-model"],
      access: { type: "zhipu-account", entitled: true },
    });
  });

  it("no active plan → not entitled, no models, unavailableReason: not-entitled", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            plans: [
              {
                plan_id: "zcode-v3-start-plan-expired",
                name: "Expired Plan",
                status: "expired",
              },
            ],
            balances: [{ capabilities: ["model:glm-5.3-flash"] }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await accountConfig(installation, env);
    expect(result.startPlan).toBe(false);
    expect(result.params.providers["account:zai-start-plan"]).toEqual({
      access: { type: "zhipu-account", entitled: false },
    });
    expect(result.params.states["account:zai-start-plan"]).toEqual({
      availability: "unavailable",
      entitled: false,
      unavailableReason: "not-entitled",
      current: true,
    });
  });

  it("pending plan → not entitled, no models, unavailableReason: not-entitled", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            server_time: 1000,
            plans: [
              {
                plan_id: "zcode-v3-start-plan-future",
                status: "active",
                starts_at: 2000,
              },
            ],
            balances: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await accountConfig(installation, env);
    expect(result.startPlan).toBe(false);
    expect(result.params.providers["account:zai-start-plan"]).toEqual({
      access: { type: "zhipu-account", entitled: false },
    });
    expect(result.params.states["account:zai-start-plan"]).toEqual({
      availability: "unavailable",
      entitled: false,
      unavailableReason: "not-entitled",
      current: true,
    });
  });

  it("HTTP 400 → not entitled, no models, unavailableReason: not-entitled", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ code: 3001, message: "parameter error" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await accountConfig(installation, env);
    expect(result.startPlan).toBe(false);
    expect(result.params.providers["account:zai-start-plan"]).toEqual({
      access: { type: "zhipu-account", entitled: false },
    });
    expect(result.params.states["account:zai-start-plan"]).toEqual({
      availability: "unavailable",
      entitled: false,
      unavailableReason: "not-entitled",
      current: true,
    });
  });

  it("network error → not entitled, no models, unavailableReason: not-entitled", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network failure"));

    const result = await accountConfig(installation, env);
    expect(result.startPlan).toBe(false);
    expect(result.params.providers["account:zai-start-plan"]).toEqual({
      access: { type: "zhipu-account", entitled: false },
    });
    expect(result.params.states["account:zai-start-plan"]).toEqual({
      availability: "unavailable",
      entitled: false,
      unavailableReason: "not-entitled",
      current: true,
    });
  });

  it("missing device id → not entitled, no models, fetch not called", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await rm(path.join(installation.dataRoot, "telemetry-state.json"));

    const result = await accountConfig(installation, env);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.startPlan).toBe(false);
    expect(result.params.providers["account:zai-start-plan"]).toEqual({
      access: { type: "zhipu-account", entitled: false },
    });
    expect(result.params.states["account:zai-start-plan"]).toEqual({
      availability: "unavailable",
      entitled: false,
      unavailableReason: "not-entitled",
      current: true,
    });
  });

  it("revision changes with the result", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            plans: [{ plan_id: "zcode-v3-start-plan-trust", status: "active" }],
            balances: [{ capabilities: ["model:glm-5.3-flash"] }],
          },
        }),
      ),
    );
    const entitled1 = await accountConfig(installation, env);

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            plans: [{ plan_id: "zcode-v3-start-plan-trust", status: "active" }],
            balances: [{ capabilities: ["model:glm-5.2"] }],
          },
        }),
      ),
    );
    const entitled2 = await accountConfig(installation, env);

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { plans: [] } })));
    const unentitled = await accountConfig(installation, env);

    expect(entitled1.params.revision).not.toEqual(entitled2.params.revision);
    expect(entitled1.params.revision).not.toEqual(unentitled.params.revision);
    expect(entitled2.params.revision).not.toEqual(unentitled.params.revision);
  });

  it("resolves endpoint origin from environment variables", () => {
    expect(resolveEndpointOrigin({})).toBe("https://zcode.z.ai");
    expect(resolveEndpointOrigin({ ZCODE_BASE_URL: "http://127.0.0.1:8080" })).toBe(
      "http://127.0.0.1:8080",
    );
  });
});

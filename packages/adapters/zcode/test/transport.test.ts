import type * as ChildProcess from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { copyFile, link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZcodeAdapter } from "../src/adapter.js";
import { CliTransport, type TransportOptions } from "../src/transport.js";
import { resolveInstallation } from "../src/installation.js";
import type { ZcodeVerifier } from "../src/verification/index.js";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  const { promisify } = await import("node:util");
  return { ...actual, execFile: Object.assign(() => {}, { [promisify.custom]: execute }) };
});

const SECRET = "fixture-only";
const JWT = "synthetic.jwt.value";
const roots: string[] = [];
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input).includes("/api/v1/zcode-plan/billing/balance")) {
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            plans: [{ plan_id: "zcode-v3-start-plan-trust", status: "active" }],
            balances: [{ capabilities: ["model:glm-5.3-flash"] }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  execute.mockReset();
  // Windows keeps a just-exited fake CLI's executable locked for a moment; retry instead of
  // failing the test on EBUSY.
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  );
});

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
            builtinModelIds: ["GLM-5.3-Flash"],
            access: { type: "zhipu-account", mode: "start-plan", accountType: "zai" },
          },
        },
        {
          providerId: "account:bigmodel-start-plan",
          config: {
            builtinModelIds: ["GLM-5.3-Flash"],
            access: { type: "zhipu-account", mode: "start-plan", accountType: "bigmodel" },
          },
        },
        {
          providerId: "account:zai-individual-coding-plan",
          config: {
            builtinModelIds: ["GLM-5.2"],
            access: { type: "zhipu-account", mode: "individual-coding-plan", accountType: "zai" },
          },
        },
      ],
    },
    modelConfigRules: {},
  },
};

function createFakeAsar(pkg: { productName: string; version: string }): Buffer {
  const pkgContent = Buffer.from(JSON.stringify(pkg), "utf8");
  const headerObj = {
    files: {
      "package.json": {
        size: pkgContent.length,
        offset: "0",
      },
    },
  };
  const jsonBuf = Buffer.from(JSON.stringify(headerObj), "utf8");
  const jsonLen = jsonBuf.length;
  const pad = (4 - (jsonLen % 4)) % 4;
  const headerSize = 4 + 4 + jsonLen + pad;
  const headerBuf = Buffer.alloc(16);
  headerBuf.writeUInt32LE(4, 0);
  headerBuf.writeUInt32LE(headerSize, 4);
  headerBuf.writeUInt32LE(jsonLen + pad + 4, 8);
  headerBuf.writeUInt32LE(jsonLen, 12);
  const padBuf = Buffer.alloc(pad, 0);
  return Buffer.concat([headerBuf, jsonBuf, padBuf, pkgContent]);
}

// The App's Electron executable runs the CLI with ELECTRON_RUN_AS_NODE=1; Node stands in for it.
async function installRuntime(appDir: string, resourcesDir: string) {
  await mkdir(resourcesDir, { recursive: true });
  await writeFile(
    path.join(resourcesDir, "app.asar"),
    createFakeAsar({ productName: "ZCode", version: "9.9.9" }),
  );
  let runtime: string;
  if (process.platform === "darwin") {
    const helperDir = path.join(
      appDir,
      "Contents",
      "Frameworks",
      "ZCode Helper.app",
      "Contents",
      "MacOS",
    );
    await mkdir(helperDir, { recursive: true });
    runtime = path.join(helperDir, "ZCode Helper");
  } else if (process.platform === "win32") {
    await mkdir(appDir, { recursive: true });
    runtime = path.join(appDir, "ZCode.exe");
  } else {
    await mkdir(appDir, { recursive: true });
    runtime = path.join(appDir, "zcode");
  }
  // Symlinks need privileges on Windows; a hard link or copy works on every CI platform.
  await (process.platform === "win32"
    ? link(process.execPath, runtime).catch(() => copyFile(process.execPath, runtime))
    : symlink(process.execPath, runtime));
  return runtime;
}

/**
 * A fake installed ZCode app whose CLI records its launch, echoes the account revision and runs
 * `handler` for other requests. `ask(method, params)` sends a reverse request with a string id.
 */
async function fixture(handler: string, credentials?: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-transport-"));
  roots.push(root);
  const appDir = path.join(root, process.platform === "darwin" ? "ZCode.app" : "ZCode");
  const resources =
    process.platform === "darwin"
      ? path.join(appDir, "Contents", "Resources")
      : path.join(appDir, "resources");
  await mkdir(path.join(resources, "glm"), { recursive: true });
  const runtime = await installRuntime(appDir, resources);
  await mkdir(path.join(resources, "config/provider"), { recursive: true });
  await mkdir(path.join(root, ".zcode/v2"), { recursive: true });
  await writeFile(
    path.join(resources, "config/provider/zcode-builtin.json"),
    JSON.stringify(builtin),
  );
  await writeFile(
    path.join(root, ".zcode/v2/telemetry-state.json"),
    JSON.stringify({ deviceMid: "fixture-device-mid" }),
  );
  if (credentials)
    await writeFile(
      path.join(root, ".zcode/v2/credentials.json"),
      JSON.stringify(
        Object.fromEntries(Object.entries(credentials).map(([k, v]) => [k, encrypt(v)])),
      ),
    );
  await writeFile(
    path.join(resources, "glm/zcode.cjs"),
    `const fs=require('node:fs');let buf=Buffer.alloc(0),n=0;const replies=new Map();
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
const ask=(method,params)=>new Promise(r=>{const id='server-'+(++n);replies.set(id,r);send({id,method,params})});
const log=v=>fs.appendFileSync(process.env.FAKE_LOG,JSON.stringify(v)+'\\n');
process.stdin.on('data',c=>{buf=Buffer.concat([buf,c]);let i;while((i=buf.indexOf(10))>=0){const m=JSON.parse(buf.subarray(0,i).toString());buf=buf.subarray(i+1);
if(m.method===undefined){log({reply:m});replies.get(m.id)?.(m);replies.delete(m.id);continue}handle(m)}});
async function handle({id,method,params}){const reply=result=>send({id,result});
if(method==='provider/updateAccountConfig'){log({argv:process.argv.slice(2),cwd:process.cwd(),builtin:process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,personal:process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,thread:process.env.CODEXHOST_THREAD_ID,params});return reply({receivedRevision:process.env.FAKE_REVISION||params.revision,providerCount:0,status:'received'})}
${handler}}`,
  );
  const options = (extra: Partial<TransportOptions> = {}): TransportOptions => ({
    cwd: root,
    environment: {
      HOME: root,
      ZCODE_DATA_BASE_DIR: root,
      ZCODE_CREDENTIAL_SECRET: SECRET,
      FAKE_LOG: path.join(root, "log.jsonl"),
    },
    app: appDir,
    verifier: () => {
      throw new Error("No verifier in this test");
    },
    ...extra,
  });
  const log = async () =>
    (await readFile(path.join(root, "log.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { root, options, appDir, resources, runtime, log };
}

async function started(options: TransportOptions) {
  const transport = new CliTransport(options);
  await transport.start();
  return transport;
}

describe("ZCode installed CLI transport", () => {
  it("reports a missing ZCode.app as not installed", async () => {
    const { options } = await fixture("");
    const transport = new CliTransport(options({ app: "/nonexistent/ZCode.app" }));
    await expect(transport.start()).rejects.toMatchObject({ code: "notInstalled" });
    await transport.close();
  });

  it("launches app-server in the workspace and publishes the Start Plan overlay first", async () => {
    const { root, options, log, resources } = await fixture("reply(null)", {
      "oauth:active_provider": "zai",
      zcodejwttoken: JWT,
    });
    const transport = await started(
      options({ environment: { ...options().environment, CODEXHOST_THREAD_ID: "thread-1" } }),
    );
    await transport.close();
    const builtinFile = path.join(resources, "config/provider/zcode-builtin.json");
    const [launch] = await log();
    expect(launch).toEqual({
      argv: ["app-server", "--stdio", "--surface", "desktop"],
      cwd: expect.stringMatching(/zcode-transport-/u),
      builtin: builtinFile,
      personal: path.join(root, ".zcode/v2/provider_config.json"),
      thread: "thread-1",
      params: {
        revision: expect.stringMatching(/^codexhost:zai:30:[a-f0-9]{16}$/u),
        basedOnZCodeBuiltinRevision: `zcode-builtin:30:${createHash("sha256").update(path.resolve(builtinFile)).digest("hex")}`,
        providers: {
          "account:zai-start-plan": {
            builtinModelIds: ["GLM-5.3-Flash"],
            access: { type: "zhipu-account", entitled: true },
          },
          "account:zai-individual-coding-plan": {
            access: { type: "zhipu-account", entitled: false },
          },
        },
        states: {
          "account:zai-start-plan": { availability: "available", entitled: true, current: true },
          "account:zai-individual-coding-plan": {
            availability: "unavailable",
            entitled: false,
            current: false,
            unavailableReason: "not-connected",
          },
        },
      },
    });
    expect(JSON.stringify(await log())).not.toContain(JWT);
  });

  it("publishes an empty overlay when ZCode Desktop is signed out", async () => {
    const { options, log } = await fixture("reply(null)");
    await (await started(options())).close();
    expect((await log())[0]).toMatchObject({
      params: {
        revision: expect.stringMatching(/^codexhost:signed-out:30:[a-f0-9]{16}$/u),
        providers: {},
        states: {},
      },
    });
  });

  it.each([
    { personal: false, codingPlan: false },
    { personal: true, codingPlan: false },
    { personal: false, codingPlan: true },
  ])(
    "isolates unreadable account credentials (personal model: $personal, coding plan: $codingPlan)",
    async ({ personal, codingPlan }) => {
      const { root, options, appDir, log } = await fixture(`
if(method==='session/create')return reply(${JSON.stringify({
        protocol: { name: "ZCode Protocol", version: 1 },
        session: {
          sessionId: "draft",
          workspace: { workspaceKey: "fixture", workspacePath: "fixture" },
          title: "",
          status: "idle",
          mode: "build",
          createdAt: 0,
          updatedAt: 0,
          sessionKind: "main",
        },
        settings: {
          model: {
            available: personal
              ? [{ ref: { providerId: "personal", modelId: "fixture" }, label: "Fixture" }]
              : [],
          },
          thoughtLevel: { enabled: false, available: [] },
          mode: { current: "build" },
        },
        projection: { status: "idle", contextUsed: 0, contextWindow: 0 },
        messages: [],
        runtime: {},
      })});reply(null);`);
      const family = "enc:v2:os:synthetic-family-ciphertext";
      const jwt = "enc:v2:os:synthetic-jwt-ciphertext";
      await writeFile(
        path.join(root, ".zcode/v2/credentials.json"),
        JSON.stringify({
          "oauth:active_provider": codingPlan ? "zai" : family,
          [codingPlan ? "oauth:zai:user_info" : "zcodejwttoken"]: jwt,
        }),
      );
      if (codingPlan)
        await writeFile(
          path.join(root, ".zcode/v2/setting.json"),
          JSON.stringify({
            providerFamilyDomain: "zai",
            providerFamilyConnectionSelections: { zai: { kind: "individual-coding-plan" } },
          }),
        );
      const adapter = new ZcodeAdapter({ environment: options().environment, app: appDir });
      try {
        const result = await adapter.inspect({ cwd: root });
        expect(fetch).not.toHaveBeenCalled();
        const [launch] = await log();
        expect(launch).toMatchObject({
          params: codingPlan
            ? {
                providers: {
                  "account:zai-individual-coding-plan": { access: { entitled: false } },
                },
              }
            : { providers: {}, states: {} },
        });
        for (const value of [family, jwt])
          expect(JSON.stringify([launch, result])).not.toContain(value);
        if (personal)
          expect(result).toMatchObject({
            status: "ready",
            catalog: { models: [{ label: "Fixture" }] },
          });
        else
          expect(result).toMatchObject({
            status: "unavailable",
            error: {
              code: "configurationRequired",
              message: expect.stringMatching(/enc:v2:.*subscription status is unknown/i),
              retryable: false,
            },
          });
      } finally {
        await adapter.close();
      }
    },
  );

  it.skipIf(process.platform === "win32").each(["denied", "timeout", "key mismatch"])(
    "retries a Keychain %s only on a targeted re-detect, sharing concurrent probes",
    async (failure) => {
      const late = failure === "timeout";
      vi.stubGlobal("process", Object.create(process, { platform: { value: "darwin" } }));
      const { root, options, appDir, log } = await fixture(`
if(method==='session/create'){
while(fs.existsSync(process.env.FAKE_DRAFT_GATE))await new Promise(r=>setTimeout(r,10));
const snapshot=${JSON.stringify({
        protocol: { name: "ZCode Protocol", version: 1 },
        session: {
          sessionId: "draft",
          workspace: { workspaceKey: "fixture", workspacePath: "fixture" },
          title: "",
          status: "idle",
          mode: "build",
          createdAt: 0,
          updatedAt: 0,
          sessionKind: "main",
        },
        settings: {
          model: {
            available: [{ ref: { providerId: "personal", modelId: "fixture" }, label: "Fixture" }],
          },
          thoughtLevel: { enabled: false, available: [] },
          mode: { current: "build" },
        },
        projection: { status: "idle", contextUsed: 0, contextWindow: 0 },
        messages: [],
        runtime: {},
      })};
if (${late} && !JSON.parse(fs.readFileSync(process.env.FAKE_LOG,'utf8').trim().split('\\n').at(-1)).params.revision.startsWith('codexhost:zai:')) snapshot.settings.model.available=[];
return reply(snapshot);}reply(null);`);
      const gate = path.join(root, "hold-draft");
      const environment = {
        ...options().environment,
        ZCODE_CREDENTIAL_SECRET: undefined,
        FAKE_DRAFT_GATE: gate,
      };
      const file = path.join(root, ".zcode/v2/credentials.json");
      const key = Buffer.alloc(32, 42);
      const iv = Buffer.alloc(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update("zai"), cipher.final()]);
      const fingerprint = createHash("sha256").update(key).digest("hex").slice(0, 24);
      const payload = [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
      await writeFile(
        file,
        JSON.stringify({ "oauth:active_provider": `enc:v2:os:${fingerprint}:${payload}` }),
      );
      execute.mockImplementation(async (_file, [method]: string[]) => {
        if (method === "default-keychain") return { stdout: `"${root}"\n` };
        if (
          execute.mock.calls.filter(([, args]) => args[0] === "find-generic-password").length === 1
        ) {
          if (failure === "key mismatch")
            return { stdout: `${Buffer.alloc(32).toString("base64url")}\n` };
          if (failure === "timeout")
            throw Object.assign(new Error("synthetic timeout"), {
              killed: true,
              code: null,
              signal: "SIGTERM",
            });
          throw new Error("synthetic denial");
        }
        return { stdout: `${key.toString("base64url")}\n` };
      });
      const adapter = new ZcodeAdapter({ environment, app: appDir });
      try {
        const cold = late
          ? {
              status: "unavailable",
              error: {
                code: "credentialAccessRequired",
                retryable: false,
                message: expect.stringMatching(/select ZCode or re-detect/i),
              },
            }
          : { status: "ready", catalog: { models: [{ label: "Fixture" }] } };
        expect(await adapter.inspect({ cwd: root })).toMatchObject(cold);
        expect(await adapter.inspect({ cwd: root, refresh: true })).toMatchObject(cold);
        expect(await adapter.open({ kind: "create", cwd: root, prewarm: true })).toMatchObject({
          ok: false,
          error: { code: "credentialAccessRequired", retryable: false },
        });
        expect(execute).not.toHaveBeenCalled();
        // A real Session can make the first attempt; a second open is not a re-detect gesture.
        await adapter.open({ kind: "create", cwd: root });
        await adapter.open({ kind: "create", cwd: root });
        await adapter.inspect({ cwd: root, credentialAccess: "allow" });
        expect(execute.mock.calls.map(([, args]) => args[0])).toEqual([
          "default-keychain",
          "find-generic-password",
        ]);

        const before = (await log()).length;
        if (late) await writeFile(gate, "");
        const passive = adapter.inspect({ cwd: root, purpose: "availability", refresh: true });
        // The account overlay being sent means this probe already skipped the cached timeout.
        if (late) await vi.waitFor(async () => expect(await log()).toHaveLength(before + 1));
        const active = adapter.inspect({ cwd: root, refresh: true, credentialAccess: "retry" });
        const concurrent = adapter.inspect({ cwd: root, refresh: true, credentialAccess: "retry" });
        if (late) await rm(gate);
        expect(await Promise.all([passive, active, concurrent])).toEqual([
          expect.objectContaining({ status: late ? "unavailable" : "ready" }),
          expect.objectContaining({ status: "ready" }),
          expect.objectContaining({ status: "ready" }),
        ]);
        expect(execute.mock.calls.map(([, args]) => args[0])).toEqual([
          "default-keychain",
          "find-generic-password",
          "default-keychain",
          "find-generic-password",
        ]);
        const launches = (await log()).slice(before);
        expect(launches).toHaveLength(late ? 2 : 1);
        expect(launches.at(-1)).toMatchObject({
          params: { revision: expect.stringMatching(/^codexhost:zai:/) },
        });
        expect(await adapter.inspect({ cwd: root })).toMatchObject({ status: "ready" });
        expect(execute).toHaveBeenCalledTimes(4);
      } finally {
        await rm(gate, { force: true });
        await adapter.close();
      }
    },
  );

  it("routes Personal Coding Plan reverse requests without JWT or verification", async () => {
    const providerId = "account:zai-individual-coding-plan";
    const apiKey = "synthetic-personal-key";
    const { root, options, log } = await fixture(
      `reply(await ask('interaction/requestProviderRuntimeHeaders',{requestId:'personal-headers',providerId:'${providerId}',modelSelection:{providerId:'${providerId}',modelId:'GLM-5.2'},accountAccess:{type:'zhipu-account',accountType:'zai',mode:'individual-coding-plan'}}))`,
      {
        "oauth:active_provider": "zai",
        "oauth:zai:user_info": JSON.stringify({ user_id: "fixture-user" }),
        [`account-provider:coding-plan:${providerId}:account:fixture-user:api-key`]: apiKey,
      },
    );
    await writeFile(
      path.join(root, ".zcode/v2/setting.json"),
      JSON.stringify({
        providerFamilyDomain: "zai",
        providerFamilyConnectionSelections: { zai: { kind: "individual-coding-plan" } },
      }),
    );
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ productName: "Coding Plan", status: "VALID", inCurrentPeriod: true }],
        }),
      ),
    );
    const transport = await started(options());
    try {
      expect(transport.startPlan).toBe(false);
      expect(await transport.request("readSession", { sessionId: "personal" })).toMatchObject({
        result: { headersApplied: true, requestAuth: { apiKey } },
      });
      expect(JSON.stringify((await log())[0])).not.toContain(apiKey);
      await writeFile(path.join(root, ".zcode/v2/credentials.json"), "{}");
      expect(await transport.request("readSession", { sessionId: "signed-out" })).toMatchObject({
        result: { headersApplied: false },
      });
    } finally {
      await transport.close();
    }
  });

  it("reports a re-announced interaction once and leaves it for resolveInteraction", async () => {
    const { options, log } = await fixture(
      `const p={requestId:'approval-1',sessionId:'s1'};ask('interaction/requestPermission',p);ask('interaction/requestPermission',p);ask('interaction/requestUserInput',{requestId:'q-1',sessionId:'s2'});reply({events:[]})`,
    );
    const transport = await started(options());
    const one = vi.fn();
    try {
      await transport.listen("onDynamicSessionEvent", { sessionId: "s1" }, one);
      await vi.waitFor(() => expect(one).toHaveBeenCalledOnce());
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(one).toHaveBeenCalledExactlyOnceWith({
        type: "permission.request",
        request: { requestId: "approval-1", sessionId: "s1" },
      });
      expect((await log()).filter((entry) => entry.reply)).toEqual([]);
    } finally {
      await transport.close();
    }
  });

  it("routes session notifications by Session and delivers subscription replay", async () => {
    const { options } = await fixture(
      `if(method==='session/subscribe'){send({method:'session/event',params:{sessionId:'other',seq:9}});send({method:'state.updated',params:{sessionId:params.sessionId,reason:'x'}});reply({events:[{sessionId:params.sessionId,seq:1}]})}`,
    );
    const transport = await started(options());
    const listener = vi.fn();
    try {
      await transport.listen(
        "onDynamicSessionEvent",
        { sessionId: "s1", deliveryKind: "desktop-continuous", includeSnapshot: false },
        listener,
      );
      expect(listener.mock.calls).toEqual([
        [{ type: "state.updated", notification: { sessionId: "s1", reason: "x" } }],
        [{ type: "session.event", event: { sessionId: "s1", seq: 1 } }],
      ]);
    } finally {
      await transport.close();
    }
  });

  describe("Start Plan request headers", () => {
    const headerRequest = `reply(await ask('interaction/requestProviderRuntimeHeaders',{requestId:'h1',sessionId:'s',workspace:{workspacePath:'/w',workspaceKey:'/w'},modelSelection:{providerId:'p',modelId:'m'},providerId:'p',accountAccess:{mode:params.sessionId},reason:'model-request'}))`;
    const verifier = (headers = { "X-Aliyun-Captcha-Verify-Param": "proof" }) => {
      const value = {
        verify: vi.fn(async () => headers),
        prewarm: vi.fn(),
        close: vi.fn(async () => {}),
      } satisfies ZcodeVerifier;
      return value;
    };

    it("answers with the decrypted JWT and fresh verification headers", async () => {
      const { options } = await fixture(headerRequest, {
        "oauth:active_provider": "zai",
        zcodejwttoken: JWT,
      });
      const fake = verifier();
      const shared = vi.fn<(appVersion: string) => ZcodeVerifier>(() => fake);
      const transport = await started(options({ verifier: shared }));
      expect(await transport.request("readSession", { sessionId: "start-plan" })).toMatchObject({
        result: {
          headersApplied: true,
          requestAuth: { apiKey: JWT, headers: { "X-Aliyun-Captcha-Verify-Param": "proof" } },
        },
      });
      // The version comes from the saved App's Info.plist, not an environment default.
      expect(shared).toHaveBeenCalledExactlyOnceWith("9.9.9");
      await transport.close();
      // The page is shared by the Host; a closing transport leaves it open.
      expect(fake.close).not.toHaveBeenCalled();
    });

    it("declines other account modes and missing sign-in without verifying", async () => {
      const { options } = await fixture(headerRequest);
      const fake = verifier();
      const transport = await started(options({ verifier: () => fake }));
      try {
        expect(
          await transport.request("readSession", { sessionId: "individual-coding-plan" }),
        ).toMatchObject({ result: { headersApplied: false, errorMessage: expect.any(String) } });
        expect(await transport.request("readSession", { sessionId: "start-plan" })).toMatchObject({
          result: { headersApplied: false, errorMessage: expect.stringMatching(/Sign in/u) },
        });
        expect(fake.verify).not.toHaveBeenCalled();
      } finally {
        await transport.close();
      }
    });

    it("reports undecryptable credentials without exposing them", async () => {
      const { options } = await fixture(headerRequest, {
        "oauth:active_provider": "zai",
        zcodejwttoken: JWT,
      });
      const transport = new CliTransport(
        options({ environment: { ...options().environment, ZCODE_CREDENTIAL_SECRET: "other" } }),
      );
      try {
        await transport.start();
        expect(transport.signedIn).toBe(false);
        expect(transport.credentialIssue).toMatch(/Cannot decrypt ZCode credentials/);
        expect(transport.credentialIssue).not.toContain(JWT);
        expect(fetch).not.toHaveBeenCalled();
        expect(await transport.request("readSession", { sessionId: "start-plan" })).toMatchObject({
          result: {
            headersApplied: false,
            errorMessage: expect.stringMatching(/Cannot decrypt ZCode credentials/),
          },
        });
      } finally {
        await transport.close();
      }
    });

    it("aborts verification when the CLI cancels the header request", async () => {
      const { options } = await fixture(
        `if(params.sessionId==='cancel'){send({method:'interaction/providerRuntimeHeadersCancelled',params:{requestId:'h1',sessionId:'s',workspace:{workspacePath:'/w',workspaceKey:'/w'}}});return reply(null)}${headerRequest.replace("params.sessionId", "'start-plan'")}`,
        { "oauth:active_provider": "zai", zcodejwttoken: JWT },
      );
      let signal: AbortSignal | undefined;
      const fake = {
        verify: vi.fn(
          (value: AbortSignal) =>
            new Promise<Record<string, string>>((_, reject) => {
              signal = value;
              value.addEventListener("abort", () => reject(new Error("aborted")));
            }),
        ),
        prewarm: vi.fn(),
        close: vi.fn(async () => {}),
      };
      const transport = await started(options({ verifier: () => fake }));
      try {
        const answer = transport.request("readSession", { sessionId: "headers" });
        await vi.waitFor(() => expect(fake.verify).toHaveBeenCalledOnce());
        await transport.request("readSession", { sessionId: "cancel" });
        expect(signal?.aborted).toBe(true);
        expect(await answer).toMatchObject({ result: { headersApplied: false } });
        expect(JSON.stringify(await answer)).not.toContain(JWT);
      } finally {
        await transport.close();
      }
    });

    it("cancels only its own verification when the transport closes", async () => {
      const { options } = await fixture(headerRequest.replace("params.sessionId", "'start-plan'"), {
        "oauth:active_provider": "zai",
        zcodejwttoken: JWT,
      });
      let signal: AbortSignal | undefined;
      const fake = {
        verify: vi.fn(
          (value: AbortSignal) =>
            new Promise<Record<string, string>>(() => {
              signal = value;
            }),
        ),
        prewarm: vi.fn(),
        close: vi.fn(async () => {}),
      };
      const transport = await started(options({ verifier: () => fake }));
      void transport.request("readSession", { sessionId: "headers" }).catch(() => undefined);
      await vi.waitFor(() => expect(fake.verify).toHaveBeenCalledOnce());
      expect(transport.startPlan).toBe(true);
      await transport.close();
      expect(signal?.aborted).toBe(true);
      expect(fake.close).not.toHaveBeenCalled();
    });
  });

  it("splits frames only at LF and keeps U+2028 inside a message", async () => {
    const { options } = await fixture("reply({text:'a\\u2028b\\u2029c'})");
    const transport = await started(options());
    try {
      expect(await transport.request("readSession", { sessionId: "s" })).toEqual({
        text: "a b c",
      });
    } finally {
      await transport.close();
    }
  });

  it("reassembles a message delivered across many chunks", async () => {
    const { options } = await fixture("reply({text:'中'.repeat(3*1024*1024)})");
    const transport = await started(options());
    try {
      expect(await transport.request("readSession", { sessionId: "s" })).toEqual({
        text: "中".repeat(3 * 1024 * 1024),
      });
    } finally {
      await transport.close();
    }
  });

  describe("64 MiB message line limit", () => {
    const MAX = 64 * 1024 * 1024;
    // Lines of an exact UTF-8 byte length, padded with 3-byte characters so a
    // character count cannot pass for a byte count.
    const sized = `const sized=(value,bytes)=>{const fill=bytes-Buffer.byteLength(JSON.stringify(value(''))),text='中'.repeat(Math.floor(fill/3))+'x'.repeat(fill%3);return JSON.stringify(value(text))};
      const bytes=Number(params.sessionId.slice(1));
      if(params.sessionId[0]==='s')process.stdout.write(sized(text=>({id,result:text}),bytes)+'\\n');
      else process.stdout.write(sized(text=>({method:'unused',params:{text}}),bytes)+'\\n'+sized(text=>({id,result:text}),bytes)+'\\n');`;
    async function transport() {
      const { options } = await fixture(sized);
      return started(options());
    }
    it("rejects a line one byte over the limit whose newline arrives in its last chunk", async () => {
      const service = await transport();
      try {
        await expect(
          service.request("readSession", { sessionId: `s${MAX + 1}` }),
        ).rejects.toMatchObject({
          code: "protocolError",
          message: "ZCode message exceeded 64 MiB",
        });
      } finally {
        await service.close();
      }
    }, 60_000);
    it.each([MAX, MAX - 1])(
      "accepts a %i byte line",
      async (bytes) => {
        const service = await transport();
        try {
          const result = await service.request("readSession", { sessionId: `s${bytes}` });
          expect(Buffer.byteLength(JSON.stringify({ id: 2, result }))).toBe(bytes);
        } finally {
          await service.close();
        }
      },
      60_000,
    );
    it("limits each line separately when several lines share a chunk", async () => {
      const service = await transport();
      try {
        const bytes = 40 * 1024 * 1024;
        const result = await service.request("readSession", { sessionId: `p${bytes}` });
        expect(Buffer.byteLength(JSON.stringify({ id: 2, result }))).toBe(bytes);
      } finally {
        await service.close();
      }
    }, 60_000);
  });

  it("gives compact its own timeout and fails the connection on other timeouts", async () => {
    const { options } = await fixture(
      "if(method==='session/compact')global.compactReply=reply;else if(method==='session/setMode'){global.compactReply({accepted:true});reply(null)}",
    );
    const transport = await started(options({ timeoutMs: 1000 }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const compact = expect(
        transport.request("compactSession", { sessionId: "s", inputId: "i" }),
      ).resolves.toEqual({ accepted: true });
      // Hold the CLI reply until the ordinary request deadline has passed.
      vi.advanceTimersByTime(1500);
      await Promise.all([compact, transport.request("setMode", { sessionId: "s" })]);
      const timedOut = expect(
        transport.request("readSession", { sessionId: "s" }),
      ).rejects.toMatchObject({ code: "unavailable" });
      await vi.advanceTimersByTimeAsync(1000);
      await timedOut;
      await expect(transport.request("setMode", { sessionId: "s" })).rejects.toMatchObject({
        code: "unavailable",
      });
    } finally {
      vi.useRealTimers();
      await transport.close();
    }
  });

  it("projects Services-owned fields onto strict CLI requests", async () => {
    const { root, options, log } = await fixture(
      "log({method,params});reply({ack:{subscriptionId:'sub'}})",
    );
    const transport = await started(options());
    try {
      await transport.request("resumeSession", { sessionId: "s" });
      await transport.request("subscribeConversationV4", { sessionId: "s" });
      await transport.request("unsubscribeConversationV4", {
        sessionId: "s",
        subscriptionId: "sub",
      });
      await transport.request("conversationRowsRangeV4", { sessionId: "s", limit: 10 });
      await transport.request("createDraftSession");
    } finally {
      await transport.close();
    }
    const workspace = { workspacePath: root, workspaceKey: root };
    const calls = (await log()).filter((entry) => entry.method);
    const connectionId = (calls[1]?.params as { connectionId: string }).connectionId;
    expect(calls).toEqual([
      { method: "session/resume", params: { sessionId: "s", workspace } },
      {
        method: "v4/conversation/subscribe",
        params: {
          topic: "conversation/s",
          connectionId: expect.stringMatching(/^codexhost-/u),
          clientMode: "desktop-continuous",
          workspace,
        },
      },
      {
        method: "v4/conversation/unsubscribe",
        params: { topic: "conversation/s", subscriptionId: "sub", connectionId },
      },
      {
        method: "v4/conversation/rowsRange",
        params: { sessionId: "s", limit: 10, clientMode: "desktop-continuous" },
      },
      { method: "session/create", params: { workspace, persistence: "deferred" } },
    ]);
  });

  it("resolves the runtime executable and fails if missing", async () => {
    const { options, appDir, runtime } = await fixture("reply({status:'ok'})");
    const installation = await resolveInstallation(options().environment, appDir);
    expect(installation.runtime).toBe(runtime);

    // Remove the runtime executable -> should fail as notInstalled
    await rm(installation.runtime);
    await expect(resolveInstallation(options().environment, appDir)).rejects.toMatchObject({
      code: "notInstalled",
    });
  });
});

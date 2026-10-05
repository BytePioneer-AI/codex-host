import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingHttpHeaders, type RequestListener } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HarnessOutput, HarnessSession } from "@codexhost/harness-adapter";
import { hostTurnIdSchema } from "@codexhost/shared-contracts";
import { ZcodeAdapter } from "../src/adapter.js";
import { resolveInstallation } from "../src/installation.js";
import { writePersonalProviderFixture } from "../../../../tests/fixtures/zcode-provider.js";

const app = process.env.CODEXHOST_TEST_ZCODE_APP;
const secret = "coding-plan-native-fixture";
function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
  const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc:v1:${[iv, cipher.getAuthTag(), bytes].map((part) => part.toString("base64url")).join(".")}`;
}
function observe(session: HarnessSession) {
  const outputs: HarnessOutput[] = [];
  void (async () => {
    for await (const output of session.outputs) outputs.push(output);
  })();
  return {
    outputs,
    async turn(id: string, outcome = "succeeded") {
      const turnId = hostTurnIdSchema.parse(id);
      expect(
        await session.execute({
          type: "turn.start",
          turnId,
          input: [{ type: "text", text: "Reply using the fixture." }],
        }),
      ).toEqual({ ok: true, value: { turnId } });
      await vi.waitFor(
        () => {
          const terminal = outputs.find(
            (output) =>
              output.kind === "event" &&
              output.event.type === "turn.completed" &&
              output.event.turnId === turnId,
          );
          expect(terminal).toBeDefined();
        },
        { timeout: 25_000 },
      );
      const terminal = outputs.find(
        (output) =>
          output.kind === "event" &&
          output.event.type === "turn.completed" &&
          output.event.turnId === turnId,
      );
      expect(terminal, JSON.stringify(terminal)).toMatchObject({
        kind: "event",
        event: { outcome: { status: outcome } },
      });
    },
  };
}

// Runs the installed CLI, but never reads the user's credentials or contacts model/plan services.
describe.skipIf(!app)("Personal Coding Plan with the installed ZCode CLI", () => {
  it.each(["zai", "bigmodel"] as const)(
    "discovers, authenticates, switches and resumes %s independently of Start Plan",
    async (family) => {
      if (!app) throw new Error("CODEXHOST_TEST_ZCODE_APP is required");
      const root = await realpath(await mkdtemp(path.join(tmpdir(), "zcode-coding-native-")));
      const apiKey = `synthetic-${family}-personal-key`;
      const providerId = `account:${family}-individual-coding-plan`;
      const requests: Array<{ url: string; headers: IncomingHttpHeaders; model: string }> = [];
      const subscriptions: IncomingHttpHeaders[] = [];
      const createVerifier = vi.fn(() => {
        throw new Error("Personal Coding Plan must not open CAPTCHA");
      });
      const handler: RequestListener = async (request, response) => {
        if (request.url === "/api/biz/subscription/list") {
          subscriptions.push(request.headers);
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              code: 0,
              data: [{ productName: "GLM Coding Plan", status: "VALID", inCurrentPeriod: true }],
            }),
          );
          return;
        }
        if (request.url === "/api/v1/agent/configs") {
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({ code: 0, data: { codingPlanSignature: { enable: false } } }),
          );
          return;
        }
        if (request.method !== "POST") {
          response.writeHead(404).end();
          return;
        }
        let body = "";
        for await (const chunk of request) body += String(chunk);
        const input = JSON.parse(body);
        requests.push({ url: request.url ?? "", headers: request.headers, model: input.model });
        const message = {
          id: "fixture",
          type: "message",
          role: "assistant",
          model: input.model,
          content: [{ type: "text", text: "CODING_PLAN_FIXTURE_OK" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 4 },
        };
        if (!input.stream) {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(message));
          return;
        }
        response.setHeader("content-type", "text/event-stream");
        const send = (type: string, data: object) =>
          response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        send("message_start", { message: { ...message, content: [], stop_reason: null } });
        send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        send("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text: "CODING_PLAN_FIXTURE_OK" },
        });
        send("content_block_stop", { index: 0 });
        send("message_delta", {
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 4 },
        });
        send("message_stop", {});
        response.end();
      };
      const server = createServer(handler);
      let tlsServer: ReturnType<typeof createHttpsServer> | undefined;
      let adapter: ZcodeAdapter | undefined;
      try {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("No fixture address");
        const origin = `http://127.0.0.1:${address.port}`;
        // Coding Plan's native signer requires HTTPS even when its feature gate is disabled.
        // Trust a generated test CA in the child only; never disable TLS verification.
        const certificate = path.join(root, "localhost.pem");
        const privateKey = path.join(root, "localhost-key.pem");
        execFileSync(
          "openssl",
          [
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=127.0.0.1",
            "-addext",
            "subjectAltName=IP:127.0.0.1",
            "-keyout",
            privateKey,
            "-out",
            certificate,
          ],
          { stdio: "ignore" },
        );
        const httpsServer = createHttpsServer(
          { key: await readFile(privateKey), cert: await readFile(certificate) },
          handler,
        );
        tlsServer = httpsServer;
        await new Promise<void>((resolve) => httpsServer.listen(0, "127.0.0.1", resolve));
        const tlsAddress = tlsServer.address();
        if (!tlsAddress || typeof tlsAddress === "string")
          throw new Error("No TLS fixture address");
        const modelOrigin = `https://127.0.0.1:${tlsAddress.port}`;
        const environment: NodeJS.ProcessEnv = {
          PATH: process.env.PATH,
          HOME: root,
          ZCODE_DATA_BASE_DIR: root,
          ZCODE_DESKTOP_HOME_DIR: root,
          ZCODE_CREDENTIAL_SECRET: secret,
          ZAI_BUSINESS_BASE_URL: origin,
          BIGMODEL_API_BASE_URL: origin,
          ZCODE_BASE_URL: origin,
          NODE_EXTRA_CA_CERTS: certificate,
        };
        const installed = await resolveInstallation(environment, app);
        const builtin = JSON.parse(await readFile(installed.builtinProviderConfig, "utf8"));
        for (const rule of builtin.config.providerConfigRules.providerRules) {
          if (rule.config.access?.type === "zhipu-account")
            rule.config.api.baseUrl = `${modelOrigin}/${rule.config.access.mode}`;
        }
        const builtinFile = path.join(root, "builtin.json");
        await writeFile(builtinFile, JSON.stringify(builtin));
        environment.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtinFile;
        const directory = path.join(root, ".zcode/v2");
        await mkdir(directory, { recursive: true });
        const credentials = {
          "oauth:active_provider": family,
          [`oauth:${family}:user_info`]: JSON.stringify(
            family === "zai"
              ? { user_id: "fixture" }
              : { id: "fixture", username: "fixture", displayName: "Fixture" },
          ),
          [`account-provider:coding-plan:${providerId}:account:fixture:api-key`]: apiKey,
        };
        const credentialFile = path.join(directory, "credentials.json");
        await writeFile(
          credentialFile,
          JSON.stringify(
            Object.fromEntries(
              Object.entries(credentials).map(([key, value]) => [key, encrypt(value)]),
            ),
          ),
        );
        const savedCredentials = await readFile(credentialFile, "utf8");
        await writeFile(
          path.join(directory, "setting.json"),
          JSON.stringify({
            providerFamilyDomain: family,
            providerFamilyConnectionSelections: { [family]: { kind: "individual-coding-plan" } },
          }),
        );
        adapter = new ZcodeAdapter({ app, environment, createVerifier, timeoutMs: 15_000 });
        // Only a paid account: an unspecified model must use native Coding Plan selection, not Start.
        const inspected = await adapter.inspect({ cwd: root });
        if (inspected.status !== "ready") throw new Error(JSON.stringify(inspected));
        expect(inspected.catalog.models.length).toBeGreaterThan(0);
        expect(
          inspected.catalog.models.every((model) =>
            model.label.includes("Individual Coding Plan /"),
          ),
        ).toBe(true);
        expect(requests).toHaveLength(0);
        const opened = await adapter.open({ kind: "create", cwd: root });
        if (!opened.ok) throw new Error(JSON.stringify(opened.error));
        const first = observe(opened.value);
        expect(opened.value.initialState.resolvedModelLabel).toContain("Individual Coding Plan /");
        await first.turn(`${family}-first`);
        const ref = opened.value.initialState.nativeRef;
        if (!ref) throw new Error("No session identity");
        await opened.value.close();
        expect(JSON.stringify(first.outputs)).not.toContain(apiKey);

        // A personal Provider remains independently available alongside the paid account.
        await writePersonalProviderFixture(root, `${origin}/personal`);
        const combined = await adapter.inspect({ cwd: root });
        if (combined.status !== "ready") throw new Error(JSON.stringify(combined));
        const paid = combined.catalog.models.find((model) =>
          model.label.includes("Individual Coding Plan /"),
        );
        const personal = combined.catalog.models.find(
          (model) => model.label === "Fixture / fixture-model",
        );
        if (!paid || !personal) throw new Error("Missing combined catalog");
        expect(
          combined.catalog.models.some((model) => model.label.startsWith("Start Plan /")),
        ).toBe(false);
        const resumed = await adapter.open({ kind: "resume", cwd: root, nativeRef: ref });
        if (!resumed.ok) throw new Error(JSON.stringify(resumed.error));
        const next = observe(resumed.value);
        await next.turn(`${family}-resumed`);
        expect(
          (await resumed.value.execute({ type: "model.select", model: personal.ref })).ok,
        ).toBe(true);
        await next.turn(`${family}-personal`);
        expect((await resumed.value.execute({ type: "model.select", model: paid.ref })).ok).toBe(
          true,
        );
        await next.turn(`${family}-paid-again`);
        // Logout must fail the selected paid request, not silently charge a personal Provider.
        await writeFile(credentialFile, "{}");
        const beforeLogout = requests.length;
        await next.turn(`${family}-signed-out`, "failed");
        expect(requests.length).toBe(beforeLogout);
        await writeFile(credentialFile, savedCredentials);
        await resumed.value.close();
        expect(JSON.stringify(next.outputs)).not.toContain(apiKey);
        const paidRequests = requests.filter((request) =>
          request.url.startsWith("/individual-coding-plan/"),
        );
        expect(paidRequests.length).toBeGreaterThanOrEqual(3);
        expect(requests.some((request) => request.url.startsWith("/personal/"))).toBe(true);
        expect(requests.some((request) => request.url.startsWith("/start-plan/"))).toBe(false);
        for (const request of paidRequests) {
          expect(
            `${request.headers.authorization ?? ""} ${request.headers["x-api-key"] ?? ""}`,
          ).toContain(apiKey);
          expect(request.headers["x-aliyun-captcha-verify-param"]).toBeUndefined();
        }
        expect(subscriptions.length).toBeGreaterThan(0);
        for (const headers of subscriptions) expect(headers.authorization).toBe(apiKey);
        expect(createVerifier).not.toHaveBeenCalled();
        expect(await readFile(credentialFile, "utf8")).toBe(savedCredentials);
      } finally {
        await adapter?.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        const httpsServer = tlsServer;
        if (httpsServer) {
          httpsServer.closeAllConnections();
          await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
        }
        await rm(root, { recursive: true, force: true });
      }
    },
    90_000,
  );
});

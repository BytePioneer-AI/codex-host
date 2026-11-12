import assert from "node:assert/strict";
import { it } from "node:test";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { remoteSessionId } from "../../src/remote-sessions.ts";
import { startServer } from "../support/server.ts";

interface Model {
  id: string;
  label: string;
}

interface RemoteModelState {
  harnessId: string;
  models: readonly [Model, Model];
  currentModel: string;
}

interface RequestBody {
  rpcId: string;
  payload?: { args?: { request?: Record<string, unknown> } };
}

type RemoteCall = {
  kind: string;
  hostId?: string;
  modelId?: string;
  [key: string]: unknown;
};

const localCatalog = {
  default: { provider: "local-only", model: "local-only-model" },
  routableProviders: ["local-only"],
  groups: [
    {
      id: "local-only",
      name: "Local Only",
      models: [{ id: "local-only-model", name: "Local Only Model" }],
    },
  ],
  failures: [],
};

const remoteModels = new Map<string, RemoteModelState>([
  [
    "remote-ssh-discovered:a",
    {
      harnessId: "fable-mac",
      models: [
        { id: "mac-primary", label: "Mac Primary" },
        { id: "mac-alternate", label: "Mac Alternate" },
      ],
      currentModel: "mac-primary",
    },
  ],
  [
    "remote-control:b",
    {
      harnessId: "fable-gateway",
      models: [
        { id: "gateway-primary", label: "Gateway Primary" },
        { id: "gateway-alternate", label: "Gateway Alternate" },
      ],
      currentModel: "gateway-primary",
    },
  ],
]);

function requestOf(body: RequestBody): Record<string, unknown> {
  return body.payload?.args?.request ?? {};
}

function remoteControls(hostId: string) {
  const state = remoteModels.get(hostId);
  assert.ok(state);
  const current = state.models.find((model) => model.id === state.currentModel);
  assert.ok(current);
  return {
    configuration: {
      owner: "external",
      harnessId: state.harnessId,
      transportModelId: state.currentModel,
      effectiveModel: { id: state.currentModel },
      resolvedModelLabel: current.label,
      effectiveThinkingOptionId: "high",
      availableThinkingOptions: [{ id: "high", label: "High" }],
      effectivePermissionModeId: "ask",
      history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
      locked: true,
    },
    inspection: {
      status: "ready",
      catalog: {
        models: state.models.map((model) => ({
          ref: { id: model.id },
          label: model.label,
          supportedThinkingOptionIds: ["high"],
        })),
        defaultModel: { id: state.models[0].id },
        thinkingOptions: [{ id: "high", label: "High" }],
        defaultThinkingOptionId: "high",
      },
      permissionModes: {
        modes: [{ id: "ask", label: "Ask" }],
        defaultModeId: "ask",
      },
      capabilities: {
        configuration: {
          selectModel: true,
          selectThinkingOption: true,
          selectPermissionMode: true,
          permissionModeScope: "live",
        },
        history: { fork: false, forkAcrossCwd: false, rollbackLastTurn: false },
      },
    },
    harness: { id: state.harnessId, name: state.harnessId },
  };
}

function modelTrigger(page: Page) {
  return page.getByRole("button", { name: /^Select model, current /u });
}

async function openModels(page: Page, current: string): Promise<void> {
  await modelTrigger(page).click();
  await page
    .getByRole("menu", { name: "Thinking", exact: true })
    .getByRole("menuitem", { name: current, exact: true })
    .click();
  await page.getByRole("menu", { name: "Model", exact: true }).waitFor();
}

it(
  "shows colliding remote sessions in the real Web shell and opens their own transcript",
  { timeout: 90_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "remote-web-browser-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const nonce = "a".repeat(32);
    const calls: RemoteCall[] = [];
    const sent = new Map<string, string>();
    const archived = new Set<string>();
    const requestIds = new Map<string, string>();
    const timestamp = Math.floor(Date.now() / 1000);
    const row = (hostId: string) => ({
      id: "same",
      cwd: "/remote/private",
      name: `Session ${hostId}`,
      modelProvider: remoteModels.get(hostId)?.harnessId ?? "openai",
      createdAt: timestamp,
      updatedAt: timestamp + (sent.has(hostId) ? 1 : 0),
      status: { type: "idle" },
      turns: [
        {
          id: "turn",
          status: "completed",
          items: [
            {
              id: "user",
              type: "userMessage",
              content: [{ type: "text", text: `Question on ${hostId}` }],
            },
            {
              id: "answer",
              type: "agentMessage",
              text: [
                `Answer from ${hostId}`,
                "![remote-posix](/tmp/remote-only.png)",
                "![remote-file](file:///tmp/remote-only.png)",
                "![remote-windows](C:/remote-only.png)",
                "![remote-fallback](/tmp/remote-only.png?version=1)",
              ].join("\n\n"),
            },
          ],
        },
        ...(sent.has(hostId)
          ? [
              {
                id: "follow-up",
                status: "completed",
                items: [
                  {
                    id: "follow-user",
                    type: "userMessage",
                    clientId: requestIds.get(hostId),
                    content: [{ type: "text", text: sent.get(hostId) }],
                  },
                  {
                    id: "follow-answer",
                    type: "agentMessage",
                    text: `Follow-up accepted on ${hostId}`,
                  },
                ],
              },
            ]
          : []),
      ],
    });
    const controller = createServer((socket) => {
      let text = "";
      socket.on("data", (chunk) => {
        text += String(chunk);
        if (!text.includes("\n")) return;
        assert.ok(text.startsWith(`REMOTE ${nonce} `));
        const input = JSON.parse(text.slice(`REMOTE ${nonce} `.length));
        const operation = input.operation;
        calls.push(operation);
        if (operation.kind === "archive") {
          if (operation.archived) archived.add(operation.hostId);
          else archived.delete(operation.hostId);
        }
        if (operation.kind === "prompt") {
          sent.set(operation.hostId, operation.text);
          requestIds.set(operation.hostId, operation.requestId);
        }
        if (operation.kind === "configure") {
          const state = remoteModels.get(operation.hostId);
          assert.ok(state);
          if (typeof operation.modelId === "string") state.currentModel = operation.modelId;
        }
        const result =
          operation.kind === "hosts"
            ? ["remote-ssh-discovered:a", "remote-control:b"].map((hostId) => ({
                hostId,
                online: true,
                displayName: hostId.startsWith("remote-ssh") ? "mac" : "custom-gateway",
                state: "connected",
              }))
            : operation.kind === "list"
              ? {
                  data: archived.has(operation.hostId) ? [] : [row(operation.hostId)],
                  nextCursor: null,
                }
              : operation.kind === "read"
                ? {
                    result: { thread: row(operation.hostId) },
                    epoch: "fixture-epoch",
                    ...remoteControls(operation.hostId),
                    requests: [],
                  }
                : {};
        socket.end(JSON.stringify({ result }) + "\n");
      });
    });
    await new Promise<void>((resolve) => controller.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => controller.close(() => resolve())));
    const address = controller.address();
    assert.ok(address && typeof address !== "string");
    const roots = [
      join(directory, "codexhost"),
      join(directory, "Library", "Application Support", "codexhost"),
    ];
    for (const root of roots) {
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, "desktop-runtime-v1.json"),
        JSON.stringify({
          schema_version: 1,
          launcher_pid: process.pid,
          control_port: address.port,
          nonce,
        }),
        { mode: 0o600 },
      );
    }
    const codexHome = join(directory, "codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      join(codexHome, ".codex-global-state.json"),
      JSON.stringify({
        "project-order": ["mac-project", "rc-project"],
        "remote-projects": [
          {
            id: "mac-project",
            hostId: "remote-ssh-discovered:a",
            remotePath: "/remote/private",
            label: "playcodex",
          },
          {
            id: "rc-project",
            hostId: "remote-control:b",
            remotePath: "/remote/private",
            label: "playcodex",
          },
        ],
      }),
    );
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      [],
      {
        environment: {
          HOME: directory,
          USERPROFILE: directory,
          LOCALAPPDATA: directory,
          XDG_RUNTIME_DIR: directory,
          CODEX_HOME: codexHome,
        },
      },
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
    const catalogSessionIds: Array<string | undefined> = [];
    const selectionRequests: Array<Record<string, unknown>> = [];
    let localCatalogCalls = 0;
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      if (request.url().endsWith("/api/session/modelCatalog")) {
        const sessionId = requestOf(request.postDataJSON() as RequestBody).sessionId;
        catalogSessionIds.push(typeof sessionId === "string" ? sessionId : undefined);
      }
      if (request.url().endsWith("/api/session/selectModel"))
        selectionRequests.push(requestOf(request.postDataJSON() as RequestBody));
    });
    await page.route("**/api/session/modelCatalog", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const body = route.request().postDataJSON() as RequestBody;
      const request = requestOf(body);
      if (request.sessionId === undefined) {
        localCatalogCalls++;
        await route.fulfill({
          json: {
            type: "server-response",
            rpcId: body.rpcId,
            result: { ok: true, value: localCatalog },
          },
        });
        return;
      }
      await route.continue();
    });
    const localMediaRequests: string[] = [];
    await page.route("**/api/file?**", async (route) => {
      localMediaRequests.push(route.request().url());
      await route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=",
          "base64",
        ),
      });
    });
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    for (const [hostId, label] of [
      ["remote-ssh-discovered:a", "mac"],
      ["remote-control:b", "custom-gateway"],
    ]) {
      const group = page
        .locator('[data-row-key^="workspace:remote-workspace:"]')
        .filter({ has: page.locator(`[data-host-id="${hostId}"]`) });
      await group.waitFor();
      assert.equal(await group.getByText("playcodex", { exact: true }).count(), 1);
      await group.getByRole("img", { name: `${label} · Connected`, exact: true }).waitFor();
      assert.equal(await group.getByRole("button", { name: /New session/ }).count(), 0);
      await group.click();
    }
    for (const hostId of ["remote-ssh-discovered:a", "remote-control:b"]) {
      const item = page.getByText(`Session ${hostId}`, { exact: true }).first();
      await item.waitFor({ timeout: 5000 }).catch(async (error: unknown) => {
        console.log({ calls, body: await page.locator("body").innerText() });
        if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
          mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
          await page.screenshot({
            path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, "remote-sessions-failure.png"),
          });
        }
        throw error;
      });
      await item.click();
      await page.getByText(`Answer from ${hostId}`, { exact: true }).waitFor();
      await page
        .locator('img[alt="remote-fallback"]')
        .or(page.getByText("remote-fallback", { exact: true }))
        .first()
        .waitFor({ state: "attached" });
      assert.equal(
        await page.locator('img[alt^="remote-"]').count(),
        0,
        "remote image paths must render as text, not local image elements",
      );

      const modelState = remoteModels.get(hostId);
      assert.ok(modelState);
      const sessionId = remoteSessionId(hostId, "same");
      await page
        .getByRole("button", {
          name: `Select Harness, current ${modelState.harnessId}`,
          exact: true,
        })
        .waitFor();
      await page.getByRole("button", { name: "Access mode, current: Ask", exact: true }).waitFor();
      await modelTrigger(page).waitFor();
      await openModels(page, modelState.models[0].label);
      const modelMenu = page.getByRole("menu", { name: "Model", exact: true });
      await modelMenu
        .getByRole("menuitemradio", { name: modelState.models[0].label, exact: true })
        .waitFor();
      assert.equal(
        await modelMenu
          .getByRole("menuitemradio", { name: "Local Only Model", exact: true })
          .count(),
        0,
        "the remote menu must not render the local Host catalog",
      );
      assert.equal(
        await modelMenu
          .getByRole("menuitemradio", { name: modelState.models[1].label, exact: true })
          .count(),
        1,
      );
      assert.ok(
        catalogSessionIds.includes(sessionId),
        `modelCatalog must carry ${sessionId}; got ${JSON.stringify(catalogSessionIds)}`,
      );
      assert.ok(localCatalogCalls > 0, "the shared local catalog should still use the no-arg call");
      const knownSessionIds = new Set(
        [...remoteModels.keys()].map((id) => remoteSessionId(id, "same")),
      );
      assert.ok(
        catalogSessionIds
          .filter((value): value is string => value !== undefined)
          .every((value) => knownSessionIds.has(value)),
      );
      await modelMenu
        .getByRole("menuitemradio", { name: modelState.models[1].label, exact: true })
        .click();
      await page
        .getByRole("button", {
          name: new RegExp(`^Select model, current ${modelState.models[1].label}\\b`),
        })
        .waitFor();
      assert.deepEqual(
        selectionRequests.findLast(
          (request) => request.sessionId === sessionId && request.model === modelState.models[1].id,
        ),
        {
          sessionId,
          provider: modelState.harnessId,
          model: modelState.models[1].id,
        },
      );
      assert.ok(
        calls.some(
          (operation) =>
            operation.kind === "configure" &&
            operation.hostId === hostId &&
            operation.modelId === modelState.models[1].id,
        ),
      );
    }
    assert.deepEqual(localMediaRequests, [], "remote paths must not request local image bytes");
    for (const state of remoteModels.values())
      assert.ok(await page.locator(`[data-harness-id="${state.harnessId}"]`).count());
    assert.ok(calls.some((call) => call.kind === "read" && call.hostId === "remote-control:b"));
    const transfer = await page.evaluateHandle(() => {
      const value = new DataTransfer();
      value.setData(
        "application/x-codexhost-thread-reference",
        JSON.stringify({
          threadId: "same",
          hostId: "remote-ssh-discovered:a",
          title: "SSH reference",
        }),
      );
      return value;
    });
    await page.locator("body").dispatchEvent("dragstart", { dataTransfer: transfer });
    const conversation = page.locator("[data-conversation-content]");
    await conversation.dispatchEvent("dragover", { dataTransfer: transfer });
    await conversation.dispatchEvent("drop", { dataTransfer: transfer });
    await page.locator('[data-composer-chip="codexhost-thread"]').waitFor();
    await transfer.dispose();
    await page.locator('[contenteditable="true"][role="textbox"]').fill("remote follow-up");
    await page.getByRole("button", { name: /Send message|发送消息/ }).click();
    await page.getByText("Follow-up accepted on remote-control:b", { exact: true }).waitFor();
    assert.equal(sent.get("remote-control:b"), "remote follow-up");
    assert.equal(sent.has("remote-ssh-discovered:a"), false);
    assert.equal(calls.filter((call) => call.kind === "prompt").length, 1);
    assert.equal(await page.getByText("remote follow-up", { exact: true }).count(), 1);
    const remoteId =
      "web-remote:" +
      Buffer.from(JSON.stringify(["remote-control:b", "same"])).toString("base64url");
    const remoteRow = page.locator(`[data-row-key="recent:${remoteId}"]`);
    await remoteRow.hover();
    await remoteRow.getByRole("button", { name: "Archive session", exact: true }).click();
    await page.getByRole("button", { name: "undo", exact: true }).waitFor();
    assert.deepEqual([...archived], ["remote-control:b"]);
    await remoteRow.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "undo", exact: true }).click();
    await remoteRow.waitFor();
    assert.equal(archived.size, 0);
    await remoteRow.click();
    await page.getByText("Follow-up accepted on remote-control:b", { exact: true }).waitFor();
    assert.deepEqual(
      calls.filter((call) => call.kind === "archive").map((call) => call.hostId),
      ["remote-control:b", "remote-control:b"],
    );
    if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
      mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, "remote-sessions.png"),
        animations: "disabled",
      });
    }
  },
);

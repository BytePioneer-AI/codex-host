import assert from "node:assert/strict";
import { it } from "node:test";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { startServer } from "../support/server.ts";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";

it(
  "shows colliding remote sessions in the real Web shell and opens their own transcript",
  { timeout: 90_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "remote-web-browser-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const nonce = "a".repeat(32);
    const calls: Array<{ kind: string; hostId?: string }> = [];
    const sent = new Map<string, string>();
    const sentTurns = new Map<string, Array<{ text: string; requestId: string }>>();
    const archived = new Set<string>();
    const requestIds = new Map<string, string>();
    const timestamp = Math.floor(Date.now() / 1000);
    const row = (hostId: string) => ({
      id: "same",
      cwd: "/remote/private",
      name: `Session ${hostId}`,
      modelProvider: hostId.startsWith("remote-ssh") ? "codexhost" : "openai",
      ...(hostId.startsWith("remote-ssh")
        ? { harnessIdentity: { id: "claude-code", name: "Claude Code" } }
        : {}),
      historyMode: hostId.startsWith("remote-ssh") ? "paginated" : "legacy",
      createdAt: timestamp,
      updatedAt: timestamp + (sentTurns.get(hostId)?.length ?? 0),
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
        ...(sentTurns.get(hostId) ?? []).map((turn, index) => ({
          id: `follow-up-${index}`,
          status: "completed",
          items: [
            {
              id: `follow-user-${index}`,
              type: "userMessage",
              clientId: turn.requestId,
              content: [{ type: "text", text: turn.text }],
            },
            {
              id: `follow-answer-${index}`,
              type: "agentMessage",
              text: `Follow-up accepted on ${hostId}${index ? ` #${index + 1}` : ""}`,
            },
          ],
        })),
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
          const history = sentTurns.get(operation.hostId) ?? [];
          history.push({ text: operation.text, requestId: operation.requestId });
          sentTurns.set(operation.hostId, history);
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
                    result: {
                      thread: operation.metadataOnly
                        ? { ...row(operation.hostId), turns: [] }
                        : row(operation.hostId),
                    },
                    epoch: "fixture-epoch",
                    requests: [],
                  }
                : operation.kind === "turns"
                  ? { data: [...row(operation.hostId).turns].reverse(), nextCursor: null }
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
    const localHost = new FakeChHost();
    const nativeRequest = localHost.request.bind(localHost);
    localHost.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      const result = await nativeRequest<T>(method, params);
      if (method !== "codexhost/harness/plugins/list") return result;
      const manifest = JSON.parse(
        readFileSync(
          resolve(import.meta.dirname, "../../../adapters/claude-code/manifest.json"),
          "utf8",
        ),
      );
      return {
        plugins: [
          ...(result as { plugins: unknown[] }).plugins,
          { id: "claude-code", name: "Claude Code", version: "1", iconStyle: manifest.iconStyle },
        ],
      } as T;
    };
    const debug = await startFakeChDebugger(localHost);
    t.after(() => debug.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      ["--ch-cdp", debug.endpoint],
      {
        authenticated: true,
        environment: {
          HOME: directory,
          USERPROFILE: directory,
          LOCALAPPDATA: directory,
          XDG_RUNTIME_DIR: directory,
          CODEX_HOME: codexHome,
        },
      },
    );
    const browser = await chromium.launch({
      ...(process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH
        ? { executablePath: process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH }
        : {}),
    });
    t.after(() => browser.close());
    const phone = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      locale: "en-US",
    });
    await phone.goto(url);
    for (const hostId of ["remote-ssh-discovered:a", "remote-control:b"]) {
      await phone.getByRole("button", { name: "Open sidebar", exact: true }).first().click();
      const group = phone
        .locator('[data-row-key^="workspace:remote-workspace:"]')
        .filter({ has: phone.locator(`[data-host-id="${hostId}"]`) });
      await group.waitFor();
      if ((await group.getAttribute("aria-expanded")) === "false") await group.click();
      const item = phone.getByText(`Session ${hostId}`, { exact: true }).first();
      await item.waitFor();
      if (hostId.startsWith("remote-ssh"))
        await item
          .locator("xpath=ancestor::*[@data-row-key][1]")
          .locator('[data-harness-id="claude-code"] svg')
          .waitFor();
      await item.click();
      await phone.getByText(`Answer from ${hostId}`, { exact: true }).waitFor();
    }
    if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
      mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
      await phone.getByRole("button", { name: "Open sidebar", exact: true }).first().click();
      await phone.waitForFunction(() => {
        const drawer = document.querySelector("[data-phone-drawer]");
        return drawer && drawer.getBoundingClientRect().left >= -1;
      });
      await phone.screenshot({
        path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, "remote-sessions-phone.png"),
        animations: "disabled",
      });
    }
    await phone.close();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
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
      const row = item.locator("xpath=ancestor::*[@data-row-key][1]");
      if (hostId.startsWith("remote-ssh")) {
        const icon = row.locator('[data-harness-id="claude-code"]');
        await icon.waitFor();
        assert.equal(await icon.locator("svg").getAttribute("viewBox"), "0 0 24 24");
        assert.equal(await row.locator("[data-native-codex-icon]").count(), 0);
      } else {
        assert.equal(await row.locator("[data-native-codex-icon]").count(), 1);
      }
    }
    assert.deepEqual(localMediaRequests, [], "remote paths must not request local image bytes");
    assert.ok(
      await page
        .locator("[data-native-codex-icon]")
        .first()
        .evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0),
    );
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
    for (const [hostId, text] of [
      ["remote-ssh-discovered:a", "second conversation"],
      ["remote-control:b", "back to first conversation"],
    ] as const) {
      const nextCount = (sentTurns.get(hostId)?.length ?? 0) + 1;
      await page.getByText(`Session ${hostId}`, { exact: true }).first().click();
      await page.getByText(`Answer from ${hostId}`, { exact: true }).waitFor();
      await page.locator('[contenteditable="true"][role="textbox"]').fill(text);
      await page.getByRole("button", { name: /Send message|发送消息/ }).click();
      await page
        .getByText(`Follow-up accepted on ${hostId}${nextCount > 1 ? ` #${nextCount}` : ""}`, {
          exact: true,
        })
        .waitFor();
    }
    assert.equal(calls.filter((call) => call.kind === "prompt").length, 3);
    assert.equal(sent.get("remote-ssh-discovered:a"), "second conversation");
    assert.equal(sent.get("remote-control:b"), "back to first conversation");
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
    await page
      .getByText("Follow-up accepted on remote-control:b", { exact: true })
      .last()
      .waitFor();
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

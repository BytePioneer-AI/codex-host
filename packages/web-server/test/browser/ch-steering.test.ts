import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChChannel, startFakeChChannel } from "../support/ch-channel.ts";
import { startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";
import { defined } from "../support/defined.ts";

for (const completeWithSteer of [false, true])
  it(
    `settles same-Turn steering echoes before subsequent replies (immediate completion: ${completeWithSteer})`,
    { timeout: 45_000 },
    async (t) => {
      const directory = mkdtempSync(join(tmpdir(), "ch-steering-browser-"));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const host = new FakeChChannel();
      const row = host.add("steering", "/computer/steering", "Steering regression");
      row.status = { type: "active" };
      row.turns = [
        {
          id: "active-turn",
          status: "inProgress",
          items: [
            {
              id: "opening",
              type: "userMessage",
              clientId: "opening-request",
              content: [{ type: "text", text: "Opening task" }],
            },
            {
              id: "tool",
              type: "commandExecution",
              command: "echo step",
              status: "inProgress",
              aggregatedOutput: "step",
            },
          ],
        },
      ];
      const turn = defined(row.turns[0]);
      const complete = () => {
        defined(turn.items[1]).status = "completed";
        turn.items.push({
          id: "answer",
          type: "agentMessage",
          text: "Steered task finished",
          phase: "final_answer",
        });
        turn.status = "completed";
        row.status = { type: "idle" };
        row.updatedAt++;
        host.changed(row.id, "turn/completed");
      };
      const arrivals = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()];
      const releases = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()];
      t.after(() => releases.forEach((release) => release.resolve(undefined)));
      const identities: string[] = [];
      const request = host.request.bind(host);
      host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
        if (method !== "turn/steer") return request<T>(method, params);
        const index = identities.length;
        assert.equal(params.expectedTurnId, turn.id);
        assert.equal(typeof params.clientUserMessageId, "string");
        identities.push(String(params.clientUserMessageId));
        defined(arrivals[index]).resolve(undefined);
        await defined(releases[index]).promise;
        turn.items.push({
          id: `steer-${index}`,
          type: "userMessage",
          clientId: params.clientUserMessageId,
          content: params.input,
        });
        if (completeWithSteer && index === 1) complete();
        else host.changed(row.id, "item/completed");
        return { turnId: turn.id, delivery: "activeTurn" } as T;
      };
      const debuggerServer = await startFakeChDebugger(host);
      t.after(() => debuggerServer.close());
      const channel = await startFakeChChannel(host, directory);
      t.after(() => channel.close());
      const url = await startServer(
        t,
        resolve(import.meta.dirname, "../.."),
        ["--import", "tsx", "src/main.ts"],
        ["--ch-cdp", debuggerServer.endpoint, "--ch-control-directory", directory],
      );
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors: string[] = [];
      const epochs = new Set<string>();
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("websocket", (socket) =>
        socket.on("framereceived", ({ payload }) => {
          const frame = JSON.parse(String(payload));
          const snapshot = frame.value;
          if (snapshot?.type === "snapshot" && snapshot.header?.id === row.id)
            epochs.add(snapshot.epoch);
        }),
      );
      await page.goto(`${url}?session=${row.id}`);
      await page.getByText("Opening task", { exact: true }).waitFor();
      for (const [index, text] of ["First steer", "Second steer"].entries()) {
        await page.locator('[contenteditable="true"]').fill(text);
        await page.keyboard.press("ControlOrMeta+Enter");
        await defined(arrivals[index]).promise;
        await page.locator('[data-submission-echo="true"]').filter({ hasText: text }).waitFor();
        defined(releases[index]).resolve(undefined);
        await page
          .locator('[data-submission-echo="true"]')
          .waitFor({ state: "hidden", timeout: 5000 });
        await page.getByText(text, { exact: true }).waitFor();
        assert.equal(await page.getByText(text, { exact: true }).count(), 1);
      }
      if (!completeWithSteer) complete();
      await page.getByText("Steered task finished", { exact: true }).waitFor();
      await page.locator("[data-chat-running]").waitFor({ state: "hidden", timeout: 5000 });
      await page.locator('[contenteditable="true"]').fill("Later follow-up");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await page.getByText("CH response: Later follow-up", { exact: true }).waitFor();
      await page.locator('[data-submission-echo="true"]').waitFor({ state: "hidden" });
      await page.locator("[data-chat-running]").waitFor({ state: "hidden" });
      const checkOrder = async () => {
        const text = await page.locator("body").innerText();
        const labels = [
          "Opening task",
          "First steer",
          "Second steer",
          "Steered task finished",
          "Later follow-up",
          "CH response: Later follow-up",
        ];
        const positions = labels.map((label) => {
          const position = text.indexOf(label);
          assert.ok(position >= 0, `missing message: ${label}`);
          return position;
        });
        for (let index = 1; index < positions.length; index++)
          assert.ok(defined(positions[index - 1]) < defined(positions[index]), labels.join(" → "));
      };
      await checkOrder();
      assert.equal(epochs.size, 1, "same-Turn additions must not replace the follow epoch");
      assert.equal(new Set(identities).size, 2);
      await page.reload();
      await page.getByText("CH response: Later follow-up", { exact: true }).waitFor();
      await checkOrder();
      assert.equal(await page.locator('[data-submission-echo="true"]').count(), 0);
      assert.equal(await page.locator("[data-chat-running]").count(), 0);
      assert.deepEqual(errors, []);
    },
  );

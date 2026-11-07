import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium, expect } from "@playwright/test";
import { FakeChChannel, startFakeChChannel } from "../support/ch-channel.ts";
import { startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "restores an active assistant at the same durable cursor and continues streaming without duplicates",
  { timeout: 30_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "ch-resume-stream-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const host = new FakeChChannel();
    const row = host.add("stream", "/computer/live-cache", "Streaming thread");
    host.add("other", "/computer/live-cache", "Other thread");
    const assistant = { id: "answer", type: "agentMessage", text: "Streaming prefix" };
    const turn = {
      id: "running",
      status: "inProgress",
      items: [
        { id: "user", type: "userMessage", content: [{ type: "text", text: "Keep going" }] },
        assistant,
      ],
    };
    row.turns = [turn];
    row.status = { type: "active" };
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const channel = await startFakeChChannel(host, directory);
    t.after(() => channel.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      ["--ch-cdp", debug.endpoint, "--ch-control-directory", directory],
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const ids = new Set<string>();
    let cancelled = false;
    const openings: Array<{ cursor: number; resumedAfter?: number; records: unknown[] }> = [];
    page.on("websocket", (socket) => {
      socket.on("framesent", ({ payload }) => {
        const frame = JSON.parse(String(payload));
        if (
          frame.type === "open" &&
          frame.endpoint === "session/follow" &&
          frame.payload.args.request.address.sessionId === row.id
        )
          ids.add(frame.streamId);
        if (frame.type === "cancel" && ids.has(frame.streamId)) cancelled = true;
      });
      socket.on("framereceived", ({ payload }) => {
        const frame = JSON.parse(String(payload));
        if (ids.has(frame.streamId) && frame.value?.type === "snapshot") openings.push(frame.value);
      });
    });
    await page.goto(`${url}?session=stream`);
    await expect(page.getByText("Streaming prefix", { exact: true })).toBeVisible();
    const folder = page.getByRole("treeitem").filter({ hasText: /^live-cache$/u });
    if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
    await page.locator('[data-row-key="session:other"]').click();
    await expect(page.getByText("existing CH answer", { exact: true })).toBeVisible();
    await expect.poll(() => cancelled).toBe(true);
    assistant.text += " while away";
    host.changed(row.id);
    await page.locator('[data-row-key="session:stream"]').click();
    await expect(page.getByText("Streaming prefix while away", { exact: true })).toBeVisible();
    assert.equal(openings[1]?.resumedAfter, openings[0]?.cursor);
    assert.equal(openings[1]?.records.length, 0);
    assistant.text += " and still live";
    host.changed(row.id);
    await expect(
      page.getByText("Streaming prefix while away and still live", { exact: true }),
    ).toHaveCount(1);
    turn.status = "completed";
    row.status = { type: "idle" };
    host.changed(row.id, "turn/completed");
    await expect(
      page.getByText("Streaming prefix while away and still live", { exact: true }),
    ).toHaveCount(1);
  },
);

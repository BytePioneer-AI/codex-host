import assert from "node:assert/strict";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import { FakeChHost, startFakeChDebugger } from "../support/ch-host.ts";
import { startServer } from "../support/server.ts";

it(
  "the local picker sends >64 MiB files, >20 files and >128 MiB total without application quotas",
  { timeout: 120_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "web-files-unlimited-browser-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const names = [
      "large-a.bin",
      "large-b.bin",
      ...Array.from({ length: 21 }, (_, index) => `small-${index}.txt`),
    ];
    const block = Buffer.alloc(1024 * 1024, 42);
    for (const name of names) {
      const path = join(root, name);
      if (name.startsWith("large")) {
        const fd = openSync(path, "wx");
        try {
          for (let index = 0; index < 65; index++) writeSync(fd, block);
        } finally {
          closeSync(fd);
        }
      } else writeFileSync(path, "small");
    }
    const host = new FakeChHost();
    host.add("existing", "/computer/files", "Existing thread");
    const native = host.request.bind(host);
    let attempts = 0;
    host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (method === "turn/start") {
        attempts++;
        const input = params.input as Array<{ type: string; text: string }>;
        assert.ok(input.every((part) => part.type === "text"));
        const lines = input[0]?.text.split("\n") ?? [];
        assert.equal(
          lines.filter((line) => line.startsWith("## ") && line !== "## My request:").length,
          names.length,
        );
        for (const name of names) {
          const line = lines.find((line) => line.startsWith(`## ${name}: `));
          assert.ok(line);
          assert.equal(
            statSync(line.slice(`## ${name}: `.length)).size,
            name.startsWith("large") ? 65 * 1024 * 1024 : 5,
          );
        }
      }
      const result = await native<T>(method, params);
      if (method === "turn/start") {
        const answer = host.threads
          .get(String(params.threadId))
          ?.turns.at(-1)
          ?.items.find((item) => item.type === "agentMessage");
        assert.ok(answer);
        answer.text = "Unlimited files accepted";
      }
      return result;
    };
    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());
    const url = await startServer(
      t,
      resolve(import.meta.dirname, "../.."),
      ["--import", "tsx", "src/main.ts"],
      [
        "--session-source",
        "codexhost",
        "--ch-cdp",
        debug.endpoint,
        "--adapters",
        "test/fake-harness",
      ],
    );
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Fixture preparation is complete. All page actions use the normal picker/editor/send controls.
    await page.goto(url);
    await page.getByText("Native Model", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Add files or run commands", exact: true }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("option", { name: /^File\b/u }).click();
    await (await chooser).setFiles(names.map((name) => join(root, name)));
    const pending = page.getByRole("group", { name: "Pending attachments", exact: true });
    await pending.getByText("large-a.bin", { exact: true }).waitFor();
    assert.equal(
      host.requests.some((request) => request.method === "thread/start"),
      false,
    );
    await page.locator('[data-composer-card] [contenteditable="true"]').fill("Read these files");
    await page.waitForFunction(
      () => {
        const button = document.querySelector<HTMLButtonElement>(
          'button[aria-label="Send message"]',
        );
        return button && !button.disabled;
      },
      undefined,
      { timeout: 60_000 },
    );
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText("Unlimited files accepted", { exact: true }).waitFor();
    await pending.waitFor({ state: "detached" });
    const body = page.locator("[data-conversation-scroll]");
    assert.equal(
      await body
        .locator("[data-message-attachments] span[title]")
        .filter({ hasText: /^(?:large-[ab]\.bin|small-\d+\.txt)/u })
        .count(),
      names.length,
    );
    await body.getByText("large-a.bin", { exact: true }).waitFor();
    assert.equal(attempts, 1);
    assert.deepEqual(errors, []);
    if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
      mkdirSync(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, "files-unlimited-sent.png"),
      });
    }
  },
);

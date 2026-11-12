import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import { chromium } from "playwright";
import { skillHost } from "../support/skill-host.ts";
import { startServer } from "../support/server.ts";
import { composerMenu } from "../support/composer-menu.ts";

for (const harnessId of ["pi", "claude-code"] as const)
  for (const width of [390, 1280])
    it(
      `${harnessId}: selected Skill sends and settles as inline conversation at ${width}px`,
      { timeout: 60_000 },
      async (t) => {
        const f = await skillHost(harnessId);
        t.after(() => f.close());
        await f.request("turn/start", {
          threadId: f.threadId,
          clientUserMessageId: "warm",
          input: [{ type: "text", text: "warm" }],
        });
        for (let n = 0; (await f.host.clientSnapshot(f.threadId)).activeTurnId && n < 100; n++)
          await delay(10);
        const url = await startServer(
          t,
          resolve(import.meta.dirname, "../.."),
          ["--import", "tsx", "src/main.ts"],
          ["--ch-control-directory", f.channelDirectory, "--ch-data", f.root],
        );
        const browser = await chromium.launch();
        t.after(() => browser.close());
        const page = await browser.newPage({
          viewport: { width, height: 900 },
          locale: "en-US",
          isMobile: width < 600,
          hasTouch: width < 600,
        });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${url}?session=${f.threadId}`);
        await page.getByText("Ready", { exact: true }).waitFor();
        const composer = page.locator("[data-composer-input]:visible");
        await composer.fill("Explain this task");
        await composerMenu(composer)();
        const name = harnessId === "pi" ? "eli5" : "lead-delegation";
        await page.getByRole("option", { name: new RegExp(`^${name}\\b`) }).click();
        const chip = composer.locator('[data-composer-chip="codexhost-native"]');
        await chip.getByText(name, { exact: true }).waitFor();
        assert.equal(await chip.locator("svg").count(), 1);
        await composer.press("Escape");
        const screenshot = async (stage: string) => {
          const directory = process.env.CODEXHOST_TEST_SCREENSHOTS;
          if (!directory) return;
          mkdirSync(directory, { recursive: true });
          await page.screenshot({
            path: join(directory, `skill-${harnessId}-${width}-${stage}.png`),
            animations: "disabled",
          });
        };
        await screenshot("composer");
        const admitted = page.waitForResponse((response) =>
          response.url().endsWith("/api/session/prompt"),
        );
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await admitted;
        assert.equal(
          f.inputs.at(-1),
          `${harnessId === "pi" ? "/skill:eli5" : "/lead-delegation"} Explain this task`,
        );
        f.delta("Skill is working");
        await page.getByText("Skill is working", { exact: true }).waitFor();
        await page.locator('[data-submission-echo="true"]').waitFor({ state: "hidden" });
        await page.locator('[data-ref-chip="skill"]').getByText(name, { exact: true }).waitFor();
        f.delta(" and completed successfully");
        f.finish();
        await page
          .getByText("Skill is working and completed successfully", { exact: true })
          .waitFor();
        await page.locator("[data-chat-running], [data-chat-sending]").waitFor({ state: "hidden" });
        const check = async () => {
          const body = await page.locator("body").innerText();
          assert.ok(
            body.indexOf("Explain this task") <
              body.indexOf("Skill is working and completed successfully"),
          );
          assert.equal(body.includes("subagent://"), false);
          assert.equal(body.includes("SKILL.md"), false);
          assert.equal(
            await page
              .getByText("Skill is working and completed successfully", { exact: true })
              .count(),
            1,
          );
        };
        await check();
        await screenshot("completed");
        await page.context().setOffline(true);
        await page.context().setOffline(false);
        await page.reload();
        await page
          .getByText("Skill is working and completed successfully", { exact: true })
          .waitFor();
        await check();
        await composer.fill("/compact");
        await composer.press("Escape");
        const compact = page.waitForResponse((response) =>
          response.url().endsWith("/api/session/prompt"),
        );
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await compact;
        await page.locator('[data-submission-echo="true"]').waitFor({ state: "hidden" });
        await page.locator("[data-chat-running], [data-chat-sending]").waitFor({ state: "hidden" });
        const snapshot = await f.host.clientSnapshot(f.threadId);
        assert.equal(snapshot.submissions?.at(-1)?.execution, "operation");
        assert.equal(snapshot.submissions?.at(-1)?.status, "completed");
        assert.equal(snapshot.turnsPage.data.length, 2);
        assert.deepEqual(errors, []);
      },
    );

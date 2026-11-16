import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { formatSkillReference } from "@codexhost/shared-contracts";
import { FakeChChannel } from "../support/ch-channel.ts";
import { discoveryBrowser } from "../support/discovery-browser.ts";
import { defined } from "../support/defined.ts";

for (const width of [390, 1280])
  it(
    `Skill Library draft, inline references and history at ${width}px`,
    { timeout: 60_000 },
    async (t) => {
      const { host, state, page, composer, menu, open } = await discoveryBrowser(t, width);
      await composer.fill("#eli5");
      await menu.getByRole("option", { name: /^eli5\b/u }).waitFor();
      assert.equal(
        host.requests.some(
          (r) => r.method === "codexhost/thread/commands/inspect" || r.method === "thread/start",
        ),
        false,
      );
      await menu.getByRole("option", { name: /^eli5\b/u }).click();
      await composer.locator('[data-composer-chip="codexhost-skill"]').waitFor();
      await composer.press("ControlOrMeta+A");
      await composer.press("ControlOrMeta+C");
      assert.equal(
        (await page.evaluate(() => navigator.clipboard.readText())).trim(),
        formatSkillReference(defined(state.skills.skills[1])),
      );
      await composer.fill("");
      await open();
      await composer.fill("请用 #eli5");
      await menu.getByRole("option", { name: /^eli5\b/u }).click();
      await composer.pressSequentially("解释 TCP 和 #library-review");
      await menu.getByRole("option", { name: /^library-review\b/u }).click();
      await composer.pressSequentially("检查结果");
      assert.equal(await composer.locator('[data-composer-chip="codexhost-skill"]').count(), 2);
      assert.equal(await composer.textContent(), "请用 eli5 解释 TCP 和 library-review 检查结果");
      await composer.press("ControlOrMeta+A");
      await composer.press("ControlOrMeta+C");
      const text = await page.evaluate(() => navigator.clipboard.readText());
      assert.equal(
        text,
        `请用 ${formatSkillReference(defined(state.skills.skills[1]))} 解释 TCP 和 ${formatSkillReference(defined(state.skills.skills[0]))} 检查结果`,
      );
      await composer.press("ArrowRight");
      // Plain pasted links also derive chips without source metadata.
      await composer.fill(text);
      assert.equal(await composer.locator('[data-composer-chip="codexhost-skill"]').count(), 2);
      await composer.press("Escape");
      const response = page.waitForResponse((r) => r.url().endsWith("/api/session/prompt"));
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await response;
      const sent = defined(host.requests.filter((r) => r.method === "turn/start").at(-1));
      assert.equal((sent.params.input as Array<{ text: string }>)[0]?.text, text);
      assert.equal(
        host.requests.some((r) => r.method === "codexhost/thread/command/execute"),
        false,
      );
      await page.locator('[data-ref-chip="skill"]').filter({ hasText: "eli5" }).waitFor();
      await page.reload();
      await open();
      await page.locator('[data-ref-chip="skill"]').filter({ hasText: "eli5" }).waitFor();
      await composer.fill("#");
      await menu.getByRole("option", { name: /^eli5\b/u }).waitFor();
      const reads = host.requests.filter((r) => r.method === "codexhost/skills/list").length;
      await composer.pressSequentially("Explain");
      await menu.getByRole("option", { name: /^eli5\b/u }).waitFor();
      assert.equal(
        host.requests.filter((r) => r.method === "codexhost/skills/list").length,
        reads,
        "description search stays local",
      );
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (process.env.CODEXHOST_TEST_SCREENSHOTS) {
        await mkdir(process.env.CODEXHOST_TEST_SCREENSHOTS, { recursive: true });
        await page.screenshot({
          path: join(process.env.CODEXHOST_TEST_SCREENSHOTS, `skill-library-${width}.png`),
          animations: "disabled",
        });
      }
    },
  );

it("queues Skill references as ordinary input while active", { timeout: 60_000 }, async (t) => {
  const { host, page, composer, menu, open } = await discoveryBrowser(t);
  defined(host.threads.get("existing")).status.type = "active";
  await page.reload();
  await open();
  await composer.fill("while working #eli5");
  await menu.getByRole("option", { name: /^eli5\b/u }).click();
  await composer.press("Escape");
  const response = page.waitForResponse((r) => r.url().endsWith("/api/session/prompt"));
  await page.getByRole("button", { name: "Queue message", exact: true }).click();
  const request = (await response).request().postDataJSON();
  assert.equal(request.payload.args.request.mode, "queue");
  assert.ok(
    host.requests
      .filter((r) => r.method === "turn/start")
      .some((r) => JSON.stringify(r.params.input).includes("Read this skill")),
  );
  assert.equal(
    host.requests.some((r) => r.method === "codexhost/thread/command/execute"),
    false,
  );
});

it("updates an open menu on a Host Skill notification", { timeout: 60_000 }, async (t) => {
  const { host, state, composer, menu, open } = await discoveryBrowser(t, 390, false, true);
  assert.ok(host instanceof FakeChChannel);
  await open();
  await composer.fill("#");
  await menu.getByRole("option", { name: /^eli5\b/u }).waitFor();
  state.skills.revision++;
  state.skills.skills.push({
    name: "new-skill",
    path: "/computer/new/SKILL.md",
    source: "Agents",
    scope: "global",
  });
  for (const listener of host.listeners)
    listener({ type: "skills-changed", cursor: { epoch: host.epoch, sequence: ++host.sequence } });
  await menu.getByRole("option", { name: /^new-skill\b/u }).waitFor();
});

it(
  "shows scan warnings as an unselectable Skills hint without a refresh action",
  { timeout: 60_000 },
  async (t) => {
    const { host, state, composer, menu, open } = await discoveryBrowser(t);
    state.skills.warnings = ["/computer/skills/broken/SKILL.md: Invalid YAML frontmatter"];
    await open();
    await composer.fill("#");
    const warning = menu.getByRole("option", { name: /^Some Skills could not be read\b/u });
    await warning.waitFor();
    assert.equal(await warning.getAttribute("aria-disabled"), "true");
    assert.match((await warning.getAttribute("title")) ?? "", /Invalid YAML frontmatter/);
    assert.equal(await menu.getByRole("option", { name: /^Retry Skill Library\b/u }).count(), 0);
    const reads = host.requests.filter((request) => request.method === "codexhost/skills/list");
    await warning.click({ force: true });
    assert.equal(
      host.requests.filter((request) => request.method === "codexhost/skills/list").length,
      reads.length,
    );
    assert.equal(await composer.textContent(), "#");
    assert.ok(reads.every((request) => !("refresh" in request.params)));
  },
);

it(
  "Skill errors retry independently of commands and delegation",
  { timeout: 60_000 },
  async (t) => {
    const { state, composer, menu, open } = await discoveryBrowser(t, 390, true);
    await open();
    state.skillFailure = "Skill scan unavailable";
    await composer.fill("#");
    await menu.getByRole("option", { name: /^Retry Skill Library\b/u }).waitFor();
    await menu.getByRole("option", { name: /^Compact\b/u }).waitFor();
    await menu.getByRole("option", { name: "Alpha alpha-agent", exact: true }).waitFor();
    state.skillFailure = "";
    await menu.getByRole("option", { name: /^Retry Skill Library\b/u }).click();
    await menu.getByRole("option", { name: /^eli5\b/u }).waitFor();
  },
);

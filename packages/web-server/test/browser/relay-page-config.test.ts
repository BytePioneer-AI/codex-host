import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { chromium } from "playwright";
import type { WebAccessState } from "@codexhost/shared-contracts";
import { startServer } from "../support/server.ts";
import { defined } from "../support/defined.ts";

for (const locale of ["en-US", "zh-CN"]) {
  it(
    `configures and enables self-hosted relay in one action with compact details in ${locale}`,
    { timeout: 60_000 },
    async (t) => {
      const login = new URL(
        await startServer(
          t,
          resolve(import.meta.dirname, "../.."),
          ["--import", "tsx", "src/main.ts"],
          [],
          { authenticated: true },
        ),
      );
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const page = await browser.newPage({ locale });
      const chinese = locale === "zh-CN";
      if (chinese) {
        const response = await page.request.post(new URL("/api/settings/mutate", login).href, {
          headers: {
            authorization: `Bearer ${login.searchParams.get("token")}`,
            origin: login.origin,
          },
          data: {
            method: "settings/mutate",
            payload: {
              args: { ns: "locale", ops: [{ op: "set", path: ["preference"], value: "zh" }] },
            },
          },
        });
        assert.equal((await response.json()).result.ok, true);
      }
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      t.after(() => assert.deepEqual(errors, []));
      const method = "codexhost/accessTokenGet";
      const response = await page.request.post(new URL(`/api/${method}`, login).href, {
        headers: { authorization: `Bearer ${login.searchParams.get("token")}` },
        data: { method, payload: { args: {} } },
      });
      const base = (await response.json()).result.value as WebAccessState;
      login.hash = "connect-devices";
      const open = async () => {
        await page.goto("about:blank");
        await page.goto(login.href);
        await page.locator("[data-connect-devices]").waitFor();
      };
      const choose = async (kind: string) => {
        await page.locator(`[data-connect-route="${kind}"] input`).check();
        await page.locator("[data-relay-status]").waitFor();
      };
      const screenshotUnconfigured = async (width: number) => {
        const directory = process.env.CODEXHOST_RELAY_SCREENSHOTS;
        if (!chinese || !directory) return;
        mkdirSync(directory, { recursive: true });
        const viewport = defined(page.viewportSize());
        // Capture the complete settings content at the requested width, not a cropped scroll position.
        const height = await page
          .locator("[data-connect-devices]")
          .evaluate((element) => element.scrollHeight + 260);
        await page.setViewportSize({ width, height: Math.max(viewport.height, height) });
        const dialogStyle = await page.getByRole("dialog").evaluate(
          (element, height) => {
            const dialog = element as HTMLElement;
            const previous = { height: dialog.style.height, maxHeight: dialog.style.maxHeight };
            dialog.style.height = `${height - 32}px`;
            dialog.style.maxHeight = "none";
            return previous;
          },
          Math.max(viewport.height, height),
        );
        await page.locator("[data-connect-devices]").evaluate((element) => {
          for (let parent = element.parentElement; parent; parent = parent.parentElement)
            parent.scrollTop = 0;
        });
        await page.screenshot({
          path: join(directory, `${width === 375 ? "phone" : "desktop"}-self-unconfigured.png`),
          fullPage: true,
        });
        await page
          .getByRole("dialog")
          .evaluate(
            (element, style) => Object.assign((element as HTMLElement).style, style),
            dialogStyle,
          );
        await page.setViewportSize(viewport);
      };
      const control = page.locator("[data-relay-status]");
      const enable = control.getByRole("button", {
        name: chinese ? "启用中转" : "Enable relay",
        exact: true,
      });
      const host = control.getByRole("textbox", {
        name: chinese ? "控制地址" : "Control hostname",
        exact: true,
      });
      const help = page.locator("[data-self-relay-help]");
      const closeFirst = chinese
        ? "请先关闭当前中转，再切换中转或修改控制地址。"
        : "Turn off the active relay before switching or changing its control address.";
      for (const width of [375, 1440]) {
        await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
        await open();
        assert.equal(await page.locator('[data-connect-route="relay"]').count(), 1);
        assert.equal(await page.locator('[data-connect-route="self-hosted-relay"]').count(), 1);
        await choose("relay");
        assert.ok((await control.textContent())?.includes("relay.chost.dev"));
        assert.ok(
          (await control.textContent())?.includes(
            chinese ? "codexhost 官方中转" : "The official codexhost relay",
          ),
        );
        const name = control.getByRole("textbox", {
          name: chinese ? "地址名（可选）" : "Address name (optional)",
        });
        for (const invalid of ["abc", "A123", "alice-bob", "a".repeat(21)]) {
          await name.fill(invalid);
          assert.equal(await enable.isEnabled(), false);
          assert.equal(await name.getAttribute("aria-invalid"), "true");
        }
        await name.fill("");
        assert.equal(await enable.isEnabled(), true);
        await choose("self-hosted-relay");
        assert.equal(
          await control
            .getByRole("textbox", { name: chinese ? "邀请码" : "Invitation code", exact: true })
            .count(),
          0,
        );
        assert.equal(await name.count(), 0);
        assert.equal(
          await control
            .getByRole("button", { name: chinese ? "保存控制地址" : "Save control address" })
            .count(),
          0,
        );
        assert.ok(
          !(await control.textContent())?.includes(chinese ? "自建中转：" : "Self-hosted relay:"),
        );
        assert.ok(
          !(await control.textContent())?.includes(
            chinese ? "codexhost 官方中转" : "The official codexhost relay",
          ),
        );
        assert.equal(await help.getAttribute("open"), "");
        const tutorial = (await help.textContent()) ?? "";
        for (const text of [
          "*.example.com",
          "relay.example.com",
          "compose.yaml",
          "Cloudflare",
          "443",
          "80",
          "Docker",
          "certbot",
          "Tailscale",
        ])
          assert.ok(tutorial.includes(text), text);
        const dns = (await help.locator("li").nth(2).textContent()) ?? "";
        for (const text of chinese
          ? ["一条 DNS 记录", "已有记录不受影响", "仅 DNS"]
          : ["one DNS record", "Existing records are unaffected", "DNS only"])
          assert.ok(dns.includes(text), text);
        const hint = control.locator(`[id="${await host.getAttribute("aria-describedby")}"]`);
        assert.ok((await hint.textContent())?.includes("relay.example.com"));
        assert.ok((await help.locator("li").nth(4).textContent())?.includes("relay.example.com"));
        assert.ok((await help.locator("li").nth(6).textContent())?.includes("relay.example.com"));
        assert.equal(await help.locator("li").count(), 7);
        assert.equal(
          await help.locator("li").nth(1).locator("code").textContent(),
          "git clone https://github.com/BytePioneer-AI/codex-host.git /opt/codexhost",
        );
        assert.equal(
          await help.getByRole("link").getAttribute("href"),
          "https://github.com/BytePioneer-AI/codex-host/blob/main/docs/product/self-hosted-relay.md",
        );
        assert.equal(await enable.isEnabled(), false);
        assert.ok(
          (await help.locator("li").first().textContent())?.includes(
            chinese ? "准备一个域名" : "You need a domain",
          ),
        );
        await screenshotUnconfigured(width);
        for (const invalid of [
          "https://relay.example.com",
          "127.0.0.1",
          "relay.example.com:443",
          "relay.example.com/path",
          "bad_.example.com",
        ]) {
          await host.fill(invalid);
          assert.equal(await enable.isEnabled(), false);
          assert.equal(await host.getAttribute("aria-invalid"), "true");
          await control.getByRole("alert").waitFor();
        }
        await host.fill("");
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
      }

      // Registration is simulated here; real endpoint switching is covered by the local Relay tests.
      let shown = base;
      const writes: Array<{ enabled: boolean; kind: string; host?: string }> = [];
      await page.route("**/api/codexhost/accessTokenGet", (route) =>
        route.fulfill({ json: { result: { ok: true, value: shown } } }),
      );
      await page.route("**/api/codexhost/relaySet", async (route) => {
        const {
          payload: { args },
        } = route.request().postDataJSON() as { payload: { args: (typeof writes)[number] } };
        writes.push(args);
        shown = {
          ...base,
          networkUrls: args.enabled
            ? [...base.networkUrls, { kind: "relay", url: "https://computer.example.com/" }]
            : base.networkUrls,
          relay: {
            ...defined(shown.relay),
            kind: "self-hosted",
            customHost: args.host ?? defined(shown.relay).customHost,
            enabled: args.enabled,
            hostname: "computer.example.com",
            state: args.enabled
              ? {
                  status: "connected",
                  url: "https://computer.example.com/",
                  certificate: { issuing: false },
                }
              : { status: "off" },
          },
        };
        await route.fulfill({ json: { result: { ok: true, value: defined(shown.relay).state } } });
      });
      await host.fill("RELAY.example.com");
      assert.equal(await enable.isEnabled(), true);
      await enable.click();
      await page.locator('[data-relay-status="connected"]').waitFor();
      assert.deepEqual(writes, [{ enabled: true, kind: "self-hosted", host: "relay.example.com" }]);
      for (const width of [375, 1440]) {
        await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
        await open();
        await page.locator('[data-relay-status="connected"]').waitFor();
        assert.equal(await host.count(), 0);
        assert.equal(await control.getByText(closeFirst, { exact: true }).count(), 0);
        await control
          .getByText(
            chinese ? "控制地址：relay.example.com" : "Control hostname: relay.example.com",
            { exact: true },
          )
          .waitFor();
        await page
          .getByRole("button", { name: chinese ? "放大二维码" : "Enlarge QR code" })
          .waitFor();
        await page
          .locator('[data-connect-route="self-hosted-relay"]')
          .getByText(chinese ? "当前使用" : "In use", { exact: true })
          .waitFor();
        assert.equal(await help.getAttribute("open"), null);
        assert.equal(await help.locator("ol").isVisible(), false);
        await help.locator("summary").click();
        assert.equal(await help.locator("ol").isVisible(), true);
        await help.locator("summary").click();
        assert.deepEqual(
          await control.evaluate((element) => ({
            address: element.nextElementSibling?.querySelector("input")?.getAttribute("aria-label"),
            tutorial:
              element.nextElementSibling?.nextElementSibling?.hasAttribute("data-self-relay-help"),
          })),
          { address: chinese ? "连接地址" : "Connection address", tutorial: true },
        );
        await page
          .getByRole("button", { name: chinese ? "复制链接" : "Copy link", exact: true })
          .waitFor();
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await choose("relay");
        assert.equal(await enable.isDisabled(), true);
        await control.getByText(closeFirst, { exact: true }).waitFor();
        assert.equal(
          await page
            .getByRole("button", { name: chinese ? "放大二维码" : "Enlarge QR code" })
            .count(),
          0,
        );
      }
      assert.equal(writes.length, 1);
      await choose("self-hosted-relay");
      await control.getByRole("button", { name: chinese ? "关闭中转" : "Turn off relay" }).click();
      await page.locator('[data-relay-status="off"]').waitFor();
      assert.equal(writes.length, 2);
      assert.equal(await host.inputValue(), "relay.example.com");
      assert.equal(await host.isEnabled(), true);
      assert.equal(await help.getAttribute("open"), null);
      await choose("relay");
      assert.equal(await enable.isEnabled(), true);
      shown = {
        ...shown,
        networkUrls: [...base.networkUrls, { kind: "relay", url: "https://phone.relay.test/" }],
        relay: {
          ...defined(shown.relay),
          kind: "official",
          enabled: true,
          hostname: "phone.relay.test",
          state: {
            status: "connected",
            url: "https://phone.relay.test/",
            certificate: { issuing: false },
          },
        },
      };
      await open();
      assert.equal(await page.locator('[data-connect-route="relay"] input').isChecked(), true);
      await page
        .locator('[data-connect-route="relay"]')
        .getByText(chinese ? "当前使用" : "In use", { exact: true })
        .waitFor();
      assert.equal(
        await page
          .locator('[data-connect-route="self-hosted-relay"]')
          .getByText(chinese ? "当前使用" : "In use", { exact: true })
          .count(),
        0,
      );
      assert.equal(writes.length, 2);
    },
  );
}

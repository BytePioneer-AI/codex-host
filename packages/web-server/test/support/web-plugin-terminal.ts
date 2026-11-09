/** Real PTY continuity probe for plugin acceptance; commands stay in the fixture workspace. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";

export async function openPluginTerminal(page: Page, workspace: string) {
  await page.locator("[data-sidebar-right-expand]").click();
  await page.locator('[data-sidebar-right-guide-entry="terminal"] button').first().click();
  try {
    await page.locator(".xterm-helper-textarea").waitFor();
  } catch (cause) {
    throw new Error(`Terminal did not open: ${await page.locator("body").innerText()}`, { cause });
  }
  await page.locator(".xterm-rows").filter({ hasText: /[$#>]/u }).waitFor();
  const stages: { stage: string; pid: string; retainedPid: string; output: string }[] = [];
  let pid: string | undefined;
  const verify = async (stage: string) => {
    const file = `terminal-${stage}.txt`;
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.insertText(
      `${pid === undefined ? "HOT_LIFETIME=$$; " : ""}printf 'HOT_PTY_%s_%s_%s\\n' '${stage}' "$$" "$HOT_LIFETIME" | tee '${file}'`,
    );
    await page.keyboard.press("Enter");
    const path = join(workspace, file);
    const deadline = Date.now() + 15_000;
    while (!existsSync(path) || !readFileSync(path, "utf8").trim()) {
      assert.ok(Date.now() < deadline, `PTY did not write ${file}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const output = readFileSync(path, "utf8").trim();
    const match = new RegExp(`^HOT_PTY_${stage}_(\\d+)_(\\d+)$`).exec(output);
    assert.ok(match, output);
    const current = match[1];
    assert.ok(current);
    pid ??= current;
    assert.equal(current, pid, "the shell process must not change");
    assert.equal(match[2], pid, "the shell variable must survive plugin changes");
    await page.locator(".xterm-rows").filter({ hasText: output }).waitFor();
    stages.push({ stage, pid: current, retainedPid: match[2], output });
  };
  await verify("before");
  return { verify, evidence: () => ({ stages }) };
}

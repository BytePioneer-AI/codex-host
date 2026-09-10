#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { updateProjectReport } from "../lib/update-report.mjs";
import { createGithub } from "../lib/github.mjs";
import { verifyBatch } from "../lib/verify-batch.mjs";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { selection: { type: "string" }, help: { type: "boolean", default: false } },
  });
  if (values.help) {
    console.log(
      "用法：node update-report.mjs <本次评估.json> [项目目录] [--selection selection.json]\n默认离线增量更新 pr-triage/。新增处理记录必须提供 --selection，通过 gh GET 复核来源后记录；不执行 GitHub 写操作。",
    );
  } else {
    if (positionals.length < 1 || positionals.length > 2)
      throw new Error("需要本次评估 JSON 及可选项目目录；参见 --help");
    let incoming = JSON.parse(await readFile(resolve(positionals[0]), "utf8"));
    if (values.selection) {
      const selection = JSON.parse(await readFile(resolve(values.selection), "utf8"));
      const github = createGithub(positionals[1]);
      await github.authenticate();
      incoming = await verifyBatch(incoming, selection, github);
    } else if (
      [...(incoming.prs ?? []), ...(incoming.issues ?? []), ...(incoming.skipped ?? [])].some(
        (item) => item.source,
      )
    ) {
      throw new Error("推进处理记录需要 --selection；离线恢复 HTML 请使用 render-report.mjs");
    }
    console.log(JSON.stringify(await updateProjectReport(incoming, positionals[1]), null, 2));
  }
} catch (error) {
  console.error(`增量更新失败：${error.message}`);
  process.exitCode = 1;
}

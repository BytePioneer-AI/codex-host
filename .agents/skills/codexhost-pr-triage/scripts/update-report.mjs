#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { updateProjectReport } from "../lib/update-report.mjs";

const args = process.argv.slice(2);
if (args.length < 1 || args.length > 2 || args.some((arg) => arg.startsWith("--"))) {
  console.error(
    "用法：node update-report.mjs <本次评估.json> [项目目录]\n默认使用当前 Git 项目，将报告增量更新到根目录的 pr-triage/。不访问 GitHub。",
  );
  process.exitCode = args[0] === "--help" ? 0 : 1;
} else {
  try {
    const incoming = JSON.parse(await readFile(resolve(args[0]), "utf8"));
    console.log(JSON.stringify(await updateProjectReport(incoming, args[1]), null, 2));
  } catch (error) {
    console.error(`增量更新失败：${error.message}`);
    process.exitCode = 1;
  }
}

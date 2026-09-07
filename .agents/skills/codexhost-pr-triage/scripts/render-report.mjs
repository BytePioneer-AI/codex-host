#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderReport, VERDICTS } from "../lib/report.mjs";

const args = process.argv.slice(2);
if (args.length !== 2 || args.some((arg) => arg.startsWith("--"))) {
  console.error(
    "用法：node render-report.mjs <report.json> <index.html>\n只读取 JSON 并生成离线 HTML，不访问 GitHub，不覆盖已有文件。",
  );
  process.exitCode = args.length === 1 && args[0] === "--help" ? 0 : 1;
} else {
  try {
    const [input, output] = args.map((arg) => resolve(arg));
    const [source, template, styles, script] = await Promise.all([
      readFile(input, "utf8"),
      readFile(new URL("../assets/report-template.html", import.meta.url), "utf8"),
      readFile(new URL("../assets/report.css", import.meta.url), "utf8"),
      readFile(new URL("../assets/report.js", import.meta.url), "utf8"),
    ]);
    const report = JSON.parse(source);
    const html = renderReport(report, { template, styles, script });
    await writeFile(output, html, { encoding: "utf8", flag: "wx" });
    console.log(
      JSON.stringify(
        {
          output,
          complete: report.complete,
          evaluated: report.prs.length,
          skipped: report.skipped.length,
          counts: Object.fromEntries(
            VERDICTS.map((verdict) => [
              verdict,
              report.prs.filter((pr) => pr.verdict === verdict).length,
            ]),
          ),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(`生成失败：${error.message}`);
    process.exitCode = 1;
  }
}

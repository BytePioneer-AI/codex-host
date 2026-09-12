#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createGithub } from "../lib/github.mjs";
import { prepareRun } from "../lib/prepare-run.mjs";

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: "string" },
      repo: { type: "string" },
      type: { type: "string", default: "all" },
      limit: { type: "string", default: "10" },
      force: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "用法：node prepare-run.mjs [编号或 GitHub Issue/PR URL...] [--type all|pr|issue] [--limit 10] [--force] [--repo OWNER/REPO] [--project 目录]\n默认增量筛选；显式编号/URL 强制复评。只通过 gh GET 读取 GitHub，写本地批次文件，不推进处理记录。",
    );
  } else {
    console.log(
      JSON.stringify(
        await prepareRun(
          {
            project: values.project,
            repository: values.repo,
            type: values.type,
            limit: Number(values.limit),
            force: values.force,
            targets: positionals,
          },
          createGithub(values.project),
        ),
        null,
        2,
      ),
    );
  }
} catch (error) {
  console.error(`准备失败：${error.message}`);
  process.exitCode = 1;
}

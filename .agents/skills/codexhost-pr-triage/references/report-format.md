# 报告数据与渲染

本文件定义 `report.json` 的版本 1 输入格式。运行时校验由 `../lib/report.mjs` 执行；模板与渲染器不推断、不修改合入建议。运行仅需 Node.js（使用仓库支持的版本），无 npm 依赖、服务器或 GitHub 凭据。

## 生成方式

1. 完成真实 PR 评估后，按下方契约写 `report.json`，不要复制示例数据充当真实结果。
2. 将 skill 目录解析为绝对路径。在新建的临时输出目录执行：

```bash
node <skill绝对路径>/scripts/render-report.mjs <report.json绝对路径> <index.html绝对路径>
```

3. 脚本先校验全部数据，再把 CSS、浏览器脚本和 JSON 注入固定模板。产物是一个独立 HTML，双击即可离线打开；不通过 `fetch()` 读取相邻 JSON。
4. 输出文件必须不存在、父目录必须已存在。脚本拒绝覆盖现有文件，包括输入 JSON；失败时非零退出并显示字段路径。修正数据后换新文件名或目录再运行。
5. 成功时 stdout 是 JSON：`output`、`complete`、`evaluated`、`skipped`、四档 `counts`。聊天摘要使用这些计数，不另行估算。

渲染器只能检查结构和部分语义约束，不能证明证据真实性、链接可访问性或评价正确性；这些仍由评估步骤核验。

## 顶层字段

所有列出的字段必填，不接受额外字段。没有内容的数组用 `[]`，允许缺失的值显式用 `null`。

| 字段 | 格式 / 含义 |
|---|---|
| `schemaVersion` | 固定为数字 `1` |
| `generatedAt` | 带时区的 ISO 时间，如 `2026-01-02T03:04:05Z`；是评估快照时间，不是打开页面的时间 |
| `repositories` | 非空、不重复的 `OWNER/REPO` 字符串数组；包含本次选取的全部仓库，即使没有 PR |
| `scope` | 非空字符串，说明“全部 open”或具体选取项、筛选范围 |
| `complete` | 布尔值；核心材料采集不完整则 `false`。仅 CI/冲突未知不使它变为 `false` |
| `errors` | 采集缺口说明字符串数组；完整报告必须为 `[]`，部分结果必须有说明。已知未完成的 PR 写明仓库和编号；未知剩余数量如实注明 |
| `prs` | 已给出唯一裁决的 PR 数组；可为 `[]`，不把未知/未处理 PR 自动填为 ACCEPT |
| `skipped` | 跳过项数组；可为 `[]` |

PR 按 `repository + number` 标识，仓库名比较不区分大小写。允许不同仓库出现同号 PR；不允许同一 PR 重复或同时出现在 `prs` 与 `skipped`。

## 每个已评估 PR

| 字段 | 格式 / 含义 |
|---|---|
| `repository` | `repositories` 中的 `OWNER/REPO` |
| `number` | 正整数 |
| `title` | 非空标题 |
| `url` | `https://github.com/OWNER/REPO/pull/N`，必须与身份一致，无 query/hash |
| `baseSha` / `headSha` | 完整 40 或 64 位十六进制 SHA；只有 DISCUSS 可用 `null`，并在理由/问题中明确缺口 |
| `verdict` | `ACCEPT` / `SIMPLIFY` / `DISCUSS` / `DECLINE` |
| `reason` | 非空单行裁决理由 |
| `value` | 非空：功能价值 |
| `scope` | 非空：实现是否克制、改动是否围绕目标（不是顶层的 PR 选取范围） |
| `cost` | 非空：维护代价 |
| `action` | 非空：下一步动作 |
| `stats` | `{ "files": 3, "additions": 10, "deletions": 2 }`，各值为非负整数；未知用 `null` |
| `integration` | 下述辅助集成信息对象；未知状态必须显式记录，不省略对象 |
| `evidence` | 下述证据数组，1–5 项；仅 DISCUSS 可为 `[]`，必须在理由/问题中说明缺口 |
| `questions` | 非空字符串数组；DISCUSS 至少一项，明确谁需要回答什么；其他档允许 `[]` |
| `simplifications` | 非空字符串数组；SIMPLIFY 至少一项，说明删减/复用/拆分办法及保留收益；其他档允许 `[]` |

### `integration`

- `ci`：`pass`、`fail`（包含超时等失败终态）、`pending`、`cancelled`、`skipped`、`none`（无检查）、`unknown` 或 `mixed`。
- `conflict`：`clear`、`conflicting` 或 `unknown`。
- `collectedAt`：带时区的 ISO 时间；采集失败也记录尝试时间。
- `note`：非空说明。注明混合状态明细、修复提醒和已知成本；没取得就写原因，不把未知估成容易或困难。

CI 聚合先看失败，再看进行中；其余终态全通过为 `pass`，全取消/跳过分别记录，对其余组合用 `mixed` 并解释。没检查为 `none`，采集失败为 `unknown`。这些状态全部允许出现在任何裁决中，渲染器不会据此降档或等待。

### 每项 `evidence`

- `label`：非空，关键文件路径/符号或需求标题。
- `url`：已核验的 http/https 链接，不得带用户名/密码；无可用链接用 `null`，仍可展示文件路径。
- `revision`：非空，文件的具体 SHA，或需求文档版本/读取时间。文件链接优先指向对应 SHA，避免漂移。
- `detail`：非空，说明该证据支持哪项判断，不只贴路径。

### 每个 `skipped` 项

恰好包含 `repository`、`number`、`title`、`url`、`reason`。身份和 URL 规则与已评估项相同，`reason` 写草稿/已关闭/已合并等跳过原因；没有 `verdict`。

## 结构示例（虚构，不能用于真实评估）

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-01-02T03:04:05Z",
  "repositories": ["example/project"],
  "scope": "结构示例：只评估 #1，不是真实 PR",
  "complete": true,
  "errors": [],
  "prs": [
    {
      "repository": "example/project",
      "number": 1,
      "title": "示例：减少重复读取",
      "url": "https://github.com/example/project/pull/1",
      "baseSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "headSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "verdict": "SIMPLIFY",
      "reason": "目标有价值，但重复持久化并非实现收益所必需。",
      "value": "减少列表加载时的重复读取。",
      "scope": "新增了可以省去的第二套持久化状态。",
      "cost": "需要额外维护两份状态的同步。",
      "action": "保留读取优化，复用既有存储。",
      "stats": { "files": 3, "additions": 100, "deletions": 10 },
      "integration": {
        "ci": "fail",
        "conflict": "clear",
        "collectedAt": "2026-01-02T03:04:05Z",
        "note": "示例：快照测试需修复；精简建议并非由 CI 失败触发。"
      },
      "evidence": [
        {
          "label": "src/cache.ts",
          "url": null,
          "revision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "detail": "示例：第二套落盘缓存重复存储已有字段。"
        }
      ],
      "questions": [],
      "simplifications": ["删除重复落盘机制，保留现有存储上的读取合并与测试。"]
    }
  ],
  "skipped": []
}
```

## 展示与安全

- 四列、聊天摘要计数和 JSON 导出均来源于同一份数据。搜索、排序、CI 显示开关只改变展示，不改裁决；页面没有 GitHub 写操作。
- 标题、说明、问题和文件名通过 `textContent` 展示。JSON 注入时转义 HTML raw-text 边界；链接限制为 http/https。不要把完整原始 PR 正文、日志、凭据或无关隐私塞进报告。
- 模板与浏览器脚本不包含默认模拟 PR。测试用数据仅位于 `test/fixtures.mjs`。
- `assets/report.css` 与 `assets/report.js` 分开维护，渲染时内联进最终 HTML，避免分发时漏文件或受 `file://` 读取限制。

## 定向验证

```bash
node --test <skill绝对路径>/test/report.test.mjs
node --test <skill绝对路径>/test/report-browser.test.mjs
```

第一组只依赖 Node.js；第二组使用仓库现有 `@playwright/test` 和本地 Chromium，检查离线打开、搜索/排序、详情、导出、跨仓库同号 PR、空/部分报告、恶意文本和移动端布局。浏览器不可用时报告阻塞原因，不自动下载或声称已通过。

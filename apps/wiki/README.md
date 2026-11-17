# CodexHost Wiki

独立的 Next.js App Router + Fumadocs + Tailwind CSS 4 + MDX 子工程，不属于根 npm workspaces，也不依赖仓库外部文件。`public/images/hero-desktop-phone.png` 是仓库展示图的独立副本。

## 本地开发与验证

使用 Node.js 24 LTS（最低 22.19）：

```sh
cd apps/wiki
npm ci
npm run dev
```

打开 <http://localhost:3000/zh> 或 <http://localhost:3000/en>。无语言前缀的 `/`、`/docs/...` 由 Fumadocs `createI18nMiddleware` 转到默认中文路由；Next.js 16 使用文件名 `proxy.ts`。

```sh
npm run typecheck
npm run lint
npm run build
npm start
```

`postinstall` 自动生成 `.source/`；`typecheck` 也会重新生成 MDX 和 Next.js 路由类型。构建不下载外部字体，不需要环境变量或运行主仓库构建。

## Vercel / v0

在 Vercel 导入仓库并设置：

| 设置 | 值 |
| --- | --- |
| Root Directory | `apps/wiki` |
| Framework Preset | Next.js |
| Node.js | 24.x |
| Install Command | `npm ci` |
| Build Command | `npm run build` |
| Output Directory | 默认 `.next`（保持框架默认） |
| Include source files outside Root Directory | 不需要 |

v0 导入/编辑时以本子工程为 Next.js 应用根目录，保留 MDX、`source.config.ts`、`postinstall`、`proxy.ts` 和锁文件；部署使用同样的 Next.js 设置。无需 `output: export` 或自定义 Vercel 路由；搜索 API 需要 Next.js 服务端运行环境。

这里只提供部署配置，没有执行远程部署或 Git 推送。

## 文档与导航约定

正文只放在 `content/docs/`，使用后缀式语言文件：

```text
content/docs/
  index.zh.mdx
  index.en.mdx
  meta.zh.json
  meta.en.json
  quick-start/
    meta.zh.json
    meta.en.json
    install.zh.mdx  ← 后续由维护者添加
    install.en.mdx  ← 后续由维护者添加
```

- `quick-start/install.zh.mdx` 对应 `/zh/docs/quick-start/install`；英文对应 `/en/docs/quick-start/install`。
- 支持 `.md` 与 `.mdx`；frontmatter 至少包含 `title`，可选 `description`、`full` 等 Fumadocs 标准字段。
- `lib/i18n.ts` 仅启用 `zh` 和 `en`。缺失的英文正文/导航回退到中文；应先创建中文版本，再补英文。
- `meta.zh.json` / `meta.en.json` 放在对应目录内；`title` 是该目录的侧栏分组名称，`pages` 按不含扩展名和语言后缀的文件名/目录名排序。`index` 指目录首页，`...` 插入未显式列出的页面。
- `defaultOpen: true` 默认展开分组，`collapsible: false` 禁止折叠。**不要设置 `root: true`**；文档布局显式使用 `tabs={false}`，保持统一侧栏。
- 全局 UI 翻译在 `lib/translations.ts`；英文使用 Fumadocs 默认文案，中文覆盖搜索、目录、主题、语言切换等控件。

### 最小占位内容

工程只有两份真实 MDX：`index.zh.mdx`、`index.en.mdx`。`lib/source.ts` 为以下首页入口复用这两份占位正文，并统一提供给路由、侧栏、搜索和 LLM 导出：

| 入口 | 路径（语言前缀之后） |
| --- | --- |
| 5 分钟上手 | `/docs/quick-start/install` |
| Agent 能力矩阵 | `/docs/agents/matrix` |
| # 多 Agent 派活 | `/docs/agents/delegation` |
| CLI / MCP / HTTP 底座 | `/docs/platform/interfaces` |
| Web 与手机 | `/docs/web/mobile` |
| 跨机运行 | `/docs/remote/cross-machine` |

添加同路径的正式文件后，真实正文（或中文缺译回退）自动优先，无需修改路由代码。首页入口标题、图标和路径在 `lib/entries.ts`。其它不存在的文档路径返回 404，不会一律展示占位正文。

## 搜索与 LLM

- `/api/search`：Fumadocs 内置 Orama，中文使用 `@orama/tokenizers/mandarin`，英文使用英文分词；UI 自动传递当前语言。可用 `?query=文档&locale=zh` 验证中文搜索。
- Fumadocs Core/UI 固定为 `16.10.6`，MDX 为 `14.3.2`，保留兼容的内置 Orama API；升级时应重新核对搜索引擎和 API，而非直接追随 latest。
- `/llms.txt`：Fumadocs `llms(source)` 生成的中英文导航索引。
- `/llms-full.txt`：通过 Fumadocs `getText("processed")` 导出的中英文全文，随构建静态生成。
- 浅色/深色/系统主题与语言切换由 Fumadocs RootProvider 和布局内置控件提供。

根目录 ESLint 排除整个独立子工程；请在这里运行 `npm run lint`。`.next/`、`.source/`、`.vercel/`、`node_modules/` 和 TypeScript 缓存不会进入 Git。

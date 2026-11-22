# CodexHost Wiki

独立的 VitePress 静态文档子工程，使用默认主题，不属于根 npm workspaces，也不依赖仓库外部文件。`public/images/hero-desktop-phone.png` 是仓库展示图的独立副本。

## 本地开发与验证

使用 Node.js 24 LTS（最低 22.19）：

```sh
cd apps/wiki
npm ci
npm run dev
```

打开 <http://localhost:3000/>（简体中文）或 <http://localhost:3000/en/>（English）。开发服务默认仅供本机访问；请勿将开发端口暴露到公网。

```sh
npm run typecheck  # TypeScript 配置与构建钩子
npm run lint       # ESLint 检查工程配置
npm run build      # 构建静态站点、检查内部死链、导出 LLM 文档
npm run preview    # 在 localhost:3000 预览构建产物
# npm start 是 npm run preview 的别名
```

所有命令均在本子工程执行，不需要运行主仓库的构建或启停服务。构建无需环境变量、服务端 API 或外部字体下载。构建产物在 `.vitepress/dist/`，临时缓存位于 `.vitepress/cache/`。

## 目录与路由

```text
.vitepress/
  config.ts       # 双语导航、侧栏、搜索与界面文案
  llms.ts         # buildEnd 钩子，生成 LLM 索引与全文
index.md          # 中文首页，layout: home
docs/             # 中文文档（16 篇）
en/
  index.md        # 英文首页，layout: home
  docs/           # 英文文档（16 篇），与中文保持相同相对路径
public/
  logo.svg
  favicon.svg
  images/hero-desktop-phone.png
```

- 中文首页 `/`，文档概览 `/docs/`，安装页 `/docs/quick-start/install`。
- 英文首页 `/en/`，文档概览 `/en/docs/`，安装页 `/en/docs/quick-start/install`。
- 中文不使用 `/zh/` 前缀。文内链接使用上述路由；顶部语言菜单切换到另一语言的同一页。
- 每篇文档使用 `.md`，frontmatter 提供 `title` 和 `description`，正文以 `# 标题` 开始。`description` 用于页面元数据，不在标题下自动展示。
- 目录顺序在 `config.ts` 的侧栏中维护；五组均不可折叠。添加页面时同步添加另一语言版本、侧栏和相关链接。
- 提示框使用 `::: info` / `::: tip` / `::: warning` / `::: details`；多标签代码可使用 `::: code-group`，无需 MDX 或 React 组件。
- 能力矩阵通过 `aside: false` 隐藏右侧目录，使用默认主题的全宽正文；表格在窄屏可横向滚动。

## 搜索与 LLM

- 使用 VitePress 内置本地搜索，无外部搜索服务或 `/api/search` 请求。搜索索引随构建生成，并按语言区分；索引与浏览器查询共用内置 `Intl.Segmenter` 分词，支持中文正文关键词，无需额外分词依赖。
- 中文搜索按钮、搜索弹窗、目录、上下页、主题及语言菜单均在 `config.ts` 配置；英文使用默认界面文案。
- `/llms.txt`：中英文文档标题、路由与简介索引。
- `/llms-full.txt`：全部 32 篇文档的 Markdown 正文及对应路由，不含 frontmatter。原生提示框等 Markdown 语法保留。
- 两个文本文件由 `buildEnd` 从当前文档生成到输出目录，不需要手动维护，也不依赖运行时服务；开发时请先构建并通过预览访问。

## Vercel 部署

导入仓库后设置：

| 设置 | 值 |
| --- | --- |
| Root Directory | `apps/wiki` |
| Framework Preset | VitePress（没有该选项时选 Other） |
| Node.js | 24.x |
| Install Command | `npm ci` |
| Build Command | `npm run build` |
| Output Directory | `.vitepress/dist` |
| Include source files outside Root Directory | 不需要 |

`vercel.json` 启用 `cleanUrls`，与 VitePress 的无扩展名链接一致。无需 Next.js 运行时、SPA 通配重写或重定向至 `index.html`；所有文档都有预渲染 HTML。其他静态托管服务需要支持目录首页及将无扩展名路径解析到对应 `.html` 文件。

以上仅说明部署设置，不会自动部署。依赖锁文件随本工程维护；`node_modules/`、`.vitepress/cache/`、`.vitepress/dist/` 和 `.vercel/` 不进入 Git。

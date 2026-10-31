# Tasks

## 1. Host 转写服务

- [x] 1.1 抽出现有 Codex 凭证文件解析供凭证导入与转写共用，凭证导入行为不变。验证：`packages/host-runtime/test/credential-imports.test.ts` 通过。
- [ ] 1.2 在 `host-runtime` 新增转写模块，以及 `codexhost/voice/status`、`codexhost/voice/transcribe` 两个客户端通道方法，在 `shared-contracts` 定义请求、结果与错误类型（不含凭证字段）。验证：新增测试覆盖无凭证、API Key、解析失败重读、过期、200、401、429、403、超时、空或超大音频，并断言凭证文件内容和修改时间不变、错误与返回值不含凭证；再用 `.work/voice-transcription-probe/sample-zh.m4a` 在 Desktop 未运行时手动转写成功。

## 2. Web Server

- [x] 2.1 新增 `POST /api/voice/transcribe` 路由（沿用 Web 认证与同源校验）与浏览器可用的语音可用性查询；音频写入 Web 数据目录的临时文件，请求结束后删除。验证：`packages/web-server/test` 新增测试覆盖成功、超大音频被拒、Host 失败与客户端中断后临时文件均已删除，以及跨源请求被拒。

## 3. Web UI

- [ ] 3.1 在 `ui-codexhost` 通过 `conversation.input.right` 提供麦克风按钮：按可用性显示，录音中显示时长、停止与取消，转写结果插入录音起始位置，插入失败时保留文字供复制或插入，失败后可重试或丢弃。验证：`npm run build:web:ui` 通过；用 `npm start web` 在桌面浏览器手动检查无凭证不显示、切换会话不误插入、拒绝权限有提示。
- [x] 3.2 更新 `docs/product/standalone-web.md`：说明当前行为、凭证只读与过期处理、额度共享和内部接口风险。验证：文档描述与实现一致；如有新文档，同步 `docs/index.md`。

## 4. 真机验证

- [ ] 4.1 在 iOS Safari 与 Android Chrome 上验证录音格式能被服务接受、HTTP 访问时按钮可见且报错清楚、断网后可重试。验证：记录各平台实际录音 MIME 与结果；若某格式被拒，按“格式不被接受”报告，不在本变更中加转码。

## 验证记录

- 1.1：`credential-imports.test.ts` 5 项通过。
- 1.2：实现与自动化测试已完成；`voice-transcription.test.ts` 14 项通过。尚未完成真实服务的离线 Desktop/CLI 验收：本机有正在运行的 Codex 相关进程，未停止或连接它们，未运行会启动 CLI 的实验脚本。因此该任务保留未勾选。
- 2.1：`node --import tsx --test packages/web-server/test/voice-http.test.ts` 3 项通过，含成功、Host 失败、声明/流式超限、上传中断、等待 Host 时中断的文件清理，以及真实路由认证/跨源拒绝。
- 3.1：实现已完成，`npm run build:web:ui` 通过；`tests/dsh/web-voice-input.spec.ts` 与 `web-voice-entry.spec.ts` 共 9 项通过，覆盖 MIME、草稿版本/锁定/会话切换、权限、取消、5 分钟停止、显式重试、挂载与可见性查询。尚未手动桌面浏览器验收；按本次执行约束未运行 `npm start web`，该任务保留未勾选。
- 3.2：已更新既有功能文档，无新增文档，未改动其他会话维护的 `docs/index.md`。
- 4.1：未做；无可用的 iOS Safari / Android Chrome 真机操作环境，未取得实际 MIME 或服务接受结果，不能以模拟录音代替验收。
- 最终检查：`npm run typecheck`、上述 28 项 Vitest 与 3 项 Web 测试、改动文件 Prettier / ESLint、`git diff --check` 均通过。并发侧栏修改期间曾暂时缺失模块，稳定后重跑 typecheck / Web 测试通过。
- `npm run lint` 的 ESLint 阶段通过，边界阶段被既有 `packages/web-server/dist/codexhost-web/node_modules/tslib/modules/index.d.ts` 的跨包导入报错阻塞；本次 8 个生产源码文件单独调用同一边界检查器通过，未清理或修改打包目录。
- 补充 UI 类型探查未通过：现有 Web UI 缺少 React / CSS 类型声明，导入的 DSH 源码也存在类型诊断。根 `typecheck` 不包含这些源码；未为此扩展依赖或修改无关文件，UI 以构建及聚焦组件/录音测试验证。

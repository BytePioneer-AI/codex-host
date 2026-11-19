# Tasks

## 1. 原生运行基础

- [x] 1.1 在 `apps/web-ui` 复用现有 Cordis Loader，并从 DSH fork commit `a28f8758b4579787e8511a2a45401e2c29ba2199` 引入所需的 Include/bundle 组合及运行依赖解析代码，不引入整套 CLI 启动或 Agent 组合；通过包公共导出连接 `@codexhost/dsh-web-backend`，补齐依赖声明、许可证和 `import-manifest.json` 来源。验证：聚焦测试覆盖原生 patch/config、多入口 bundle、包内依赖解析、宿主 Cordis 实例一致性及真实版本诊断，并执行受影响类型与依赖边界检查。
- [x] 1.2 复用 DSH `webServer`，增加可嵌入现有监听器的接缝，在 `packages/web-server/src/main.ts` 的认证之后分派，保留原生路由、升级、首页注入和注销语义；保护内置路由、连接通道及恢复入口，不开第二个端口，不添加插件权限系统。验证：HTTP 测试覆盖 exact/prefix 匹配、冲突、GET/HEAD/条件响应、未认证访问、写请求与升级的同源规则、路由异常和注销；同步 Web server 的接入说明。
- [x] 1.3 将已启用原包通过原生 Loader 接入现有 `dsh-web-backend` Context，以受管理的插件生命周期释放用户贡献，不用清空根 Context 的方式处理扩展失败；保留既有文件、终端和 Gateway 服务，不伪造额外 Agent 服务。验证：夹具覆盖原包 Host 入口执行、未启用不执行、必需依赖缺失、注册后抛错与清理、内置服务冲突及关闭时 disposer，回归 `dsh-right-sidebar.test.ts`、`dsh-terminal.test.ts`。

## 2. 装配、管理与恢复

- [x] 2.1 用原生 `ClientModules` 承接运行时前端发现和启动图，收敛 `web-assets.ts`、`external-client-assets.ts` 的重复装配逻辑；保留现有纯客户端包、共享浏览器模块、资源版本语义及开发 HMR，恢复页由同一内置集合投影且不应用用户首页注入。验证：扩展 `web-assets.test.ts` 和浏览器扩展测试，覆盖 bundle 中客户端贡献、纯客户端入口、分块、版本响应、模块冲突、正常页/恢复页及 `dev-web-hmr.test.ts`；同步扩展兼容边界文档。
- [x] 2.2 接通加载结果与现有扩展管理状态，保留安装/启用操作不执行入口、默认禁用、本机管理和重启生效；卸载先移除登记，运行中的安装文件在生命周期释放后再清理，并在下次启动清理残留；`--safe-mode` 在导入用户代码前生效。验证：扩展 `ui-extensions.test.ts`、`ui-extension-rpc.test.ts` 及浏览器恢复测试，覆盖加载失败不影响内置界面、仍可禁用、卸载前后资源存续、安全模式不执行 Host 代码、页面恢复不停止服务端与远程管理拒绝；更新 `docs/product/web-ui-extensions.md` 和 `docs/proposals/ui-extension-plugins.md`，明确可信代码边界及已启用包的行为变化。

## 3. 发行与原包验收

- [x] 3.1 调整 `packages/web-server/scripts/pack.ts` 的运行依赖和资源布局，使原生 Loader、服务、内置客户端与外置包在仓库外共享正确的宿主实例，不依赖源码路径或另一套 DSH；记录发行运行约束。验证：通过现有 `pack` 入口构建临时发行目录，移动到仓库外后运行聚焦 distribution 测试，覆盖带共享 peer 的插件、包内资源、缺依赖诊断和 `dsh-bundled-backend.test.ts` 的已有协议字段。
- [x] 3.2 使用官方 npm 原包 `@smalltailqwq/dsh-client-ui-skin-maid-atelier@0.1.9` 与 `open-sea-skin@1.2.7`，分别在源码和仓库外发行运行中执行安装、启用、重启、浏览器展示、禁用及恢复；保留既有 Blackgold 原包验收入口，不将两种主题必须同时叠加列为兼容承诺。验证：核对归档/入口哈希、Maid 人物/背景/边框及图片响应、Open Sea HTML/JS/CSS/字体及实际海洋背景，保存截图与浏览器错误观测，确认禁用后的路由消失；在现有产品文档记录实际结果和平台/GPU限制，未执行的原包检查不得标为通过，不将第三方艺术资源提交进仓库。
- [ ] 3.3 在内置基线及上述原包分别启用时完成 codexhost 核心回归：聊天发送与流式响应、Harness 选择/切换、会话创建与历史、文件访问、终端输入输出、设置保存；复用 `ch-realtime`、`ch-switching`、`ch-sessions`、`harness-discovery-menu`、`right-sidebar-files`、`right-sidebar-terminal`、`preferences` 等现有用例并补齐启用扩展的运行参数。验证：沿用 `package.json` 的 Web/browser/distribution 测试入口选择聚焦文件，DSH 客户端单测使用 `tests/vitest.config.js`，按最终 diff 运行类型、边界与构建检查；所有服务由测试支持代码在临时数据目录、随机端口和模拟 Host 下运行，不调用 `npm start`/`npm stop` 操作用户服务，不发起真实模型请求；记录跳过或阻塞的检查及原因。

### 验证状态

- 扩展聚焦 Node 测试 63 项、DSH 界面管理单测 11 项通过；文件、终端及 bundled backend 回归通过。源码浏览器 HMR、扩展管理、Blackgold 原包通过；GitHub 在线安装用例未重跑，使用固定作者归档验证。
- Maid/Open Sea 官方 npm integrity 与归档一致，Host/client 哈希固定；源码和移出仓库的发行包均完成原包验收。发行实例从其自身目录以普通 Node 启动，不借助工作树的 tsx。截图与观测保存在 `/tmp/codexhost-native-acceptance/`，不提交艺术资源。
- `npm run typecheck`、受影响文件 ESLint、边界检查和临时发行构建通过；没有升级共享 Host 的 Cordis，没有操作当前 Web/Host 服务。
- 3.3 保持未完成：Maid 和 Open Sea 各有 15 项核心浏览器用例通过，`preferences.test.ts` 未通过。无插件基线也复现资源设置页跨页面同步缺失：Host 的空闲超时已设为 42，页面仍为 30；Open Sea 还复现另一页面未显示已启用的超时控件。该问题位于既有设置同步路径，未扩大本变更修改它。其余基线用例通过，未运行全仓全量测试或 Windows/Linux/GPU 设备矩阵。

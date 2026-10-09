# 独立 Web 应用

Web 与 Codex Desktop 集成在同一仓库开发，但分别运行。浏览器连接 `packages/web-server` 的 Node 服务；服务直接加载 Harness 插件，不连接 Desktop Host，也不使用 Desktop 的所有权记录、映射数据库或启动器。Web/PWA 共用响应式界面；尚无 iOS/Android 原生封装。

## 代码与构建

- `packages/adapters/*`：唯一的 Harness 接入实现。既有插件保持当前 CH 源码；`packages/adapters/codex` 是迁入的独立 Codex app-server Adapter，不改变 Desktop 原生 Codex 路径，也不加入 Desktop 预装清单。
- `packages/web-server`：Web 会话存储、HTTP/WebSocket、交互关联、Harness 事件到 DSH 界面协议的投影、认证与 Web Push。
- `apps/web-ui`：从 DSH 衍生的浏览器界面、Cordis 浏览器运行时与协议源码；仅保留所选界面依赖，来源和许可见其 README。未迁入 DSH CLI、独立 Agent Loop、原仓库 CI 或 Git 历史。

仓库统一使用 npm Workspace 和 `package-lock.json`。Web 消费公共插件上下文与命令类型；现有会话投影仍使用结构化类型子集，并不是新的 Harness 专属实现。旧 DSH 协议字段 `provider` 在本应用中携带 Harness ID，不表示 Model Provider。

```sh
npm ci
npm run build:web
npm run start:web
# 3180 已有旧 Web 服务时，不重启 Desktop；改用另一端口：
npm run start:web -- --port 3181
```

`build:web` 编译当前工作树的 CH 包并调用已有插件构建器，随后编译前端和打包。插件输入为 `packages/host-runtime/dist/plugins`，不是已安装的 CH.app 或另一个仓库。用量统计专用插件不作为聊天 Harness；Web 另行打包同仓库的 Codex Adapter。

发行目录为 `packages/web-server/dist/codexhost-web`，包含 Node 服务、Web 界面和自包含 Adapter。整体目录可以移动到仓库外运行，无需 CH.app、Codex Desktop、源码目录或仓库的 node_modules；Harness CLI 和其认证仍由用户安装、配置。

## Harness 与 Model 选择

Composer 的模型/推理等级控件旁提供独立的 Harness 图标按钮。菜单沿用 Desktop 的“图标、Harness 名称、当前勾选”方式；图标来自插件资源，不从 Model Provider 名称推测。就绪插件可选，检查失败的条目标记为不可用。

新会话可切换 Harness；选择时采用该 Harness 目录的首个可用 Model 及其默认推理等级，随后可单独选择其他 Model。模型菜单和 `/model` 只列当前 Harness 的模型。两个控件共用原来的目录、`session/selectModel` 和确认后的持久投影，不维护另一份选中状态。

会话有原生历史后固定 Harness；菜单仍展示其他 Harness，但禁用切换并提示新建会话。当前 Harness 内的 Model 选择保持可用。重新连接或刷新按持久投影恢复，不把现有 Native Session 迁到另一个 Harness。

## 原生权限与会话标识

权限菜单及 `/permission` 读取当前会话的 Adapter 权限目录，保留原生模式 ID、标签、描述与危险标记；不再把 `auto` 解释成 DSH 的 Auto review，也不使用进程全局权限目录为不同 Harness 套用相同预设。危险模式有显式确认；无原生可选权限能力的 Harness 隐藏入口。`atCreate` 模式仅在原生会话创建前可选，之后锁定；原生拒绝显示错误，不伪造切换成功。未打开原生会话时保存所选 ID并在 `Adapter.open` 时传入，已有会话通过 `permissionMode.select` 下发。跨 Harness 的草稿切换恢复目标 Harness 原生默认值，不继承同名模式的语义。全局默认权限设置入口不再显示，因为各 Harness 的模式与生效范围并不相同。

左侧会话行读取服务端持久元数据中的绑定 Harness（草稿读取该会话的已选 Harness），显示插件品牌图标，不从当前 Composer 或其他会话的默认选择推测。未打开的历史会话同样显示，刷新可恢复；运行、审批和未读状态叠加在图标旁，归档保留身份。缺少图标资源时使用通用图标，不伪造其他品牌。

## 并发运行与预览

`start:web` 使用隔离的 Claude Code 预览入口，固定监听 localhost 并保留访问令牌认证。服务子进程不继承 `CODEXHOST_*`、`NODE_OPTIONS` 或 `NODE_PATH`。预览默认数据目录为 `~/.codexhost-web-preview`，工作区为 `~/codexhost-web-preview-workspace`；支持 `--port`、`--data`、`--workspace`，以及逗号分隔的 `--harness <id,...>`。默认仅 Claude Code；`npm run start:web -- --harness all` 启用本发行包除 Codex、Pi 和用量统计专用插件外的所有会话插件。显式选择 Codex/Pi、缺失插件或用量统计插件会在启动前报错。

启用插件不等于机器已安装、认证对应 CLI，也不等于所有能力已完成 Web 验收。模型菜单只列检查就绪的 Harness；未安装的不会列为可用，检查失败由目录接口报告。Codex、Pi 的独立启动入口仍未验证，隔离预览始终拒绝启用；其他插件所需的可选 Host 上下文以及完整界面能力也需逐项验收。不要从 CH 承载的 Agent 会话直接启动继承原环境的 `server.mjs`，也不要把 Desktop 的环境变量恢复到预览进程。

Web 和 Desktop 可以共享 CLI 安装及登录账号，不应同时恢复并写入同一个 Native Session，也不应让两个 Agent 同时修改同一工作目录。Web Host 元数据独立，不意味着原生 Harness 会话文件或账号额度隔离。

## 验证与限制

```sh
npm run typecheck
npm run test:web
npm run test:web:distribution
npm run test:web:browser
```

服务端和浏览器测试使用假 Harness 与临时数据，不提交真实模型请求。浏览器检查覆盖手机尺寸的设置、主题持久化、发送、断网重连和历史恢复；发行检查覆盖仓库外运行、插件资源和隔离启动参数。迁入的 Codex Item 映射测试由仓库 Vitest 配置运行。

CH 与 Web 后端纳入现有 TypeScript 检查；迁入前端由 tsdown/Vite 编译并接受浏览器回归，原 DSH 的完整前端类型检查与测试配置尚未迁入。自动化浏览器尺寸测试不替代真机键盘、后台生命周期和 HTTPS Web Push 验收。图片/附件仍被明确拒绝；没有把文件路径伪装成图片支持。

# Tasks

> 依赖关系：第 1 组先行。完成后第 2、3、4 组可以并行推进（4.1 与 4.2 也可以并行，约定以 1.1 的契约为准）。第 5 组依赖前面全部完成。测试统一用 `tests/vitest.config.js` 只跑相关文件；跨包契约变化才加 `npx tsc -b packages/<pkg>`。

## 1. 契约（shared-contracts）

- [x] 1.1 新增 `desktop-extensions.ts`：manifest（含保留字段 `backend` 的两步解析）、启用配置、状态文件 schema、槽位枚举、纯函数 `resolveDesktopExtensionSlots`、`DesktopExtensionApiV1` 与 `define` 的类型。新增 `thread-tree-watch.ts`：watch、unwatch、snapshot 的 schema 和上限常量。从包入口导出。验证：在最近的 shared-contracts 测试中用 `test.each` 覆盖以下情况——有效 manifest、未知字段为无效、`backend` 或 `desktopApi: 2` 为不兼容、未知槽位为无效、按 `enabled` 顺序判定槽位冲突；再运行 `npx tsc -b packages/shared-contracts`。

- [x] 1.2 支持双语名称和向后兼容的字符串名称、可选的预置分类多选及重复项校验。从 `shared-contracts` 导出本地化取值 helper；覆盖发现、Console 列表及冲突、Host 设置列表和 Controller 对账；同步两个样板与作者文档。
- [ ] 1.3 Desktop / Web 设置和 Console 页面消费双语元数据、分类标签、作者、仓库、详情和截图。
- [x] 1.4 扩展 manifest 的可选展示字段和六种用途分类；打包与发现复用截图路径、权限、大小及签名校验；管理列表返回有总量上限的 `screenshotDataUrls`。覆盖无效 URL、缺失、越界、超限、伪装类型、列表上限及打包复制，更新样板 manifest 和作者 Skill。

## 2. 主干 Thread 树订阅（host-runtime）

- [x] 2.1 新增 `thread-tree-watch.ts`，在 `app-server-host.ts` 中只加路由。实现内容：快照（`parents` 复用 `ThreadTree.read()`）、本地状态（审批、提问含多选、计划审阅；快照直接检查 Desktop 待处理多选提问，不改变 Delegation 提问契约）、250 ms 合并推送、版本号、5000 节点上限与 `truncated`、连接关闭时释放订阅。官方 Thread 的初始状态按 design 中的 Open Question 确认。验证：新增聚焦测试，覆盖首次快照、新委派在 1 s 内推送、Turn 开始与结束、多选提问报告为 `waiting`、置顶子 Thread 成为顶层、截断标记、断开连接后不再推送；现有 Web `tree/read` 测试保持通过。
- [x] 2.2 实现 owner 合并：前端 Host 有订阅者时，经 `SharedThreadBridge` 向 owner 建立一条 watch；owner 拥有的 Thread 采用 owner 的状态；owner 断开或版本过旧时报告 `unknown`，诊断只记一次；截获 owner 的 snapshot 通知，不转发给 Desktop。验证：扩展 `local-shared-host.test.ts`，覆盖 Web 发起的共享外部 Thread 在 Desktop 快照中先为 `running`、结束后为 `idle`，owner 断开时为 `unknown`，Desktop 输出流中不出现 owner 的 snapshot 通知。同步更新 `docs/architecture/web-thread-tree.md`，补充订阅协议与 owner 合并规则。

## 3. 扩展文件与 Console（harness-plugin-files、console-server、renderer-extension/console）

- [x] 3.1 在 `harness-plugin-files` 中新增 `extension-discovery.ts` 和 `extension-configuration.ts`，复用 `pluginResourcePath` 与 `readPluginFile`。功能包括：目录名必须等于 id、大小上限、POSIX 属主与权限检查、`contentHash`、启用配置的原子写入与 `expectedRevision`、配置缺失时使用空集合且无诊断，配置损坏时使用空集合并给出诊断、`reloadToken`。验证：使用临时目录的聚焦测试，覆盖有效、无效、符号链接逃逸、超限、可被他人写入、不兼容、版本号冲突、损坏的配置；扩展发现使用独立的 `desktop-extensions/` 根目录；Console 不列出 Pi Adapter 在 `extensions/` 下的目录，也不把缺失的 `enabled.json` 显示为诊断。
- [x] 3.2 在 console-server 中新增 `extensions.ts` 和 `/api/extensions` 系列路由（list、enable、disable、disable-all-and-reload），沿用 `request-guard`；在 `renderer-extension/src/console/pages/extensions.ts` 新增管理页面（列表、状态、冲突与不兼容原因、兜底按钮）。验证：console-server 聚焦测试覆盖以下情况——状态文件过期时显示"等待 Desktop"、启用冲突扩展返回 409 并给出占用者、拒绝启用不兼容扩展、禁用全部时写入空集合和新令牌、未通过 request guard 的请求被拒绝；页面由维护者手动检查，不写页面测试。同步更新 `docs/operations/codexhost-console.md`。

## 4. Desktop 注入与宿主 API（renderer-extension、desktop-control）

- [x] 4.1 新增 `desktop-extension-host.ts` 和 `desktop-extension-api.ts`：内部注册表（`??=` 安装，由 probe 的 dispose 调用 `disposeAll`）、串行对账、等宿主桥就绪后再激活、`define`/`activate` 约定与超时、v1 原语（封装 `SidebarAgentIconDom`；把 #947 的 `openCodexThread` 并入 `codex-schedule-navigation.ts`；本机 Harness 目录；页面内共享一份 tree watch）、清理超时后的强制回收、卸载后丢弃迟到的投递、错误预算、防御性槽位检查。验证：renderer-extension 聚焦测试覆盖 hash 相同不重复激活、更新时先卸载后激活、未提供清理的扩展被禁用后挂载节点被移除且被标记的原生行恢复显示、清理超时仍完成回收、迟到的 tree 快照不交给已卸载扩展、回调连续出错进入 `failed` 而其他扩展不受影响、`openThread` 拒绝非本机请求。
- [x] 4.2 在 desktop-control 中新增 `renderer-desktop-extensions.ts`，接入 `installTarget`、`ensureInstalled` 和 production-controller 的启动与关闭。实现内容：`fs.watch` 只作提示，配合防抖、`executionContextCreated` 与 30 s 兜底扫描；只保留一个快照脚本标识，先移除旧标识再注册新标识；先更新快照脚本再做实时对账；Controller 重启时先读 `status()`；`reloadToken` 只处理一次并记录在案；写 `diagnostics/desktop-extensions-v1.json`。验证：用现有注入 CDP operations 的方式写聚焦测试（文件系统使用真实临时目录），覆盖集合变化时标识被替换且任何时刻只有一个、hash 未变时不重新发送脚本、目标被替换后重新挂接、Controller 重启后不重复注入、令牌只触发一次 `Page.reload`、配置损坏时对账为空集合。

## 5. 样板、边界与验收

- [x] 5.1 新增 `tools/build-desktop-extension.mjs`（esbuild 打包单文件并写出 manifest），用 #926 和 #947 的适配样板验证构建、导入约束和 v1 manifest。样板源码及其专用测试存于 `handoff/desktop-extensions-926-947`。
- [x] 5.2 新增 `docs/architecture/desktop-ui-extensions.md`，写现状行为、目录与 manifest、API v1、槽位、回收承诺与边界、作者指南、兜底流程和 v2 预留；更新 `docs/index.md`，并更新 CLAUDE.md 中 `harness-plugin-files` 的描述。验证：文档中的链接可达，描述与已实现的行为一致。
- [ ] 5.3 按 `codexhost-isolated-testing` 在独立数据目录的 Desktop 中验收以下流程：启用委派树样板后无需刷新即可生效 → 启用角标样板时被拒绝并提示冲突 → 禁用委派树后原生侧栏恢复 → 启用角标样板，Web 发起的子 Thread 显示为运行中 → 修改样板文件后完成热更新且只有一个实例 → 重载窗口后仍只有一个实例 → Controller 重启保留原实例，离线重载不运行扩展、重连后按最新选择恢复（方案 A）→ 让样板抛出异常，确认显示为失败且其他功能正常 → 执行"禁用全部并重载"。记录实际验证范围和跳过项；未实际运行的步骤不得标记为完成，也不用 `npm start` 代替验证。

### 5.3 验收记录

未运行原生 Codex Desktop：机器已有用户服务，源码 Desktop 启动入口会先清理现有 Desktop 进程，未使用该入口。以下是隔离替代验证，不覆盖真实 Desktop 的私有 DOM／React 绑定、Launcher 和原生导航，也不把 5.3 标为完成。

实跑的是独立 Chromium profile、真实 CDP、当前 worktree 构建的 Console 和扩展宿主、两个实际打包产物。测试页面以本地和远程侧栏行模拟 Desktop，由替代桥提供行、导航和快照；CDP 目标与注入 URL 守卫仅在临时驱动中映射到这个页面。Console 不依赖 Host 即可验证扩展管理；其他 Host 相关页面未测试。

| 步骤                      | 隔离验证结果                                                                                                                                                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 启用委派树                | Console 启用后无需刷新。原生样式测试行隐藏，远程行可见，展开后子行可点击并调用桥的导航；文档标识和输入草稿不变。                                                                                                                                           |
| 启用冲突角标              | Console 显示 409 冲突的提示，指出占用者 `sidebar-thread-tree`，保存选择不变。                                                                                                                                                                              |
| 禁用委派树                | 树移除、原生测试行恢复可见、宿主标记消失，原生行没有新增 `class` 或 `style`。                                                                                                                                                                              |
| 共享子 Thread 的运行状态  | 浏览器端以注入的 `running` 快照验证角标与弹层。另实跑 `local-shared-host.test.ts` 的共享所有者用例：Web 协议客户端用模拟 Harness 发起 Turn，Desktop 订阅收到 `running` → `idle` → 断开为 `unknown`。**未实跑真实 Web 操作到原生 Desktop 角标的整条链路。** |
| 修改样板文件              | 原子替换样板 CSS 触发热更新；新规则生效，文档未刷新，只剩一个角标节点和一份样式表。                                                                                                                                                                        |
| 在线重载                  | 文档更换后只有一个角标节点和一份样式表。                                                                                                                                                                                                                   |
| Controller 重启／离线重载 | 强制退出再连接同一文档，核心和角标实例保留。离线重载不注入，离线禁用角标后重连只恢复仍启用的无槽位扩展，符合方案 A。                                                                                                                                       |
| 扩展异常                  | 激活抛错在 Console 显示 `failed` 和错误信息；出错前挂载的节点及标记被回收，角标和无槽位扩展仍运行。                                                                                                                                                        |
| 禁用全部并重载            | 从 Console 确认操作后，启用列表为空，文档重载，无扩展节点或样式表，原生测试行可见。                                                                                                                                                                        |

隔离运行继承 `HOME`，使用独立 `CODEXHOST_DATA_DIR` 和临时 loopback 端口（最终一轮：Console `51653`、测试页面 `51652`、CDP `51657`）。退出并确认测试进程及监听均已结束，删除了隔离 `/tmp` 数据。未运行 `npm start` / `npm stop`，未触碰 `~/.codexhost` 或干扰 `:4400` / `:4398`。

## 1. 事实、支持范围与方案

- [x] 1.1 确认 Legacy ApiProxy 删除提交、发布标签分界和 alpha.4/alpha.5 Web Remote 公开能力
- [x] 1.2 比较 Web Remote、ACP、SDK，记录不能降级替代的历史/Fork/命令/交互差异
- [x] 1.3 将最终支持集合固定为 Legacy `0.1.1-rc.2` 与 Modern `0.1.2-rc.1`；其他 release 全部失败关闭
- [x] 1.4 定义一个公开 Adapter、两个完整内部实现、managed-only Modern 与 18～20 个最终行为提交
- [x] 1.5 每次实现发现推翻方案事实时同步 proposal/design/spec/tasks，并重新运行 OpenSpec strict validation

## 2. Legacy 隔离与代际选择

- [x] 2.1 将现有 Host ApiProxy Adapter、Session、history、projection、permission 与测试隔离到 Legacy 边界，保持文件树重构前后行为一致
- [x] 2.2 只提取两代已证明同义的 executable/version、Model Ref 与 Harness Command 纯逻辑
- [x] 2.3 实现一次成功后固定、失败可由显式 refresh 重试、close 可中止/排空的 delegate selector
- [x] 2.4 对 exact rc.2 executable/wire、exact rc.1 executable、所有其他版本、unknown service 和并发 inspect/open 增加聚焦测试
- [x] 2.5 已识别未支持 release 返回 `unsupported`、非重试且以中英文提示升级到 `dsh-v0.1.2-rc.1`；旧 Host 占位 version 不参与 release 判断
- [x] 2.6 保留 exact rc.2 Legacy endpoint probe；拒绝外部 Modern endpoint/bootstrap URL，且不启动共享同一 home 的竞争 Modern Web

## 3. Modern managed Web、认证与 Remote 传输

- [x] 3.1 实现 `--port 0` managed Web 启动、readiness grammar、stdout/stderr 持续消费、token→cookie 交换和 owned-process bounded teardown
- [x] 3.2 严格校验 loopback URL、单 token、manual 303、`Location: /`、Host-only Cookie、Path/HttpOnly/SameSite 与 authority
- [x] 3.3 实现严格 unary Remote envelope、同 rpcId、Remote error、timeout、AbortSignal 和有限 response body
- [x] 3.4 实现带 Cookie 的 `/api/remote.mux` logical stream、open/cancel、有限 `maxPayload`、错 streamId/乱序/terminal 校验
- [x] 3.5 为 readiness、stdout、unary、WebSocket、record、pagination 和 diagnostic 定义命名的有限常量；oversize 一律 protocolError
- [x] 3.6 添加 secret canary、401/403、redirect/cookie 拒绝、backpressure、process exit、selection/close race 和资源泄漏测试

## 4. Modern journal 与 `session/control`

- [x] 4.1 使用 `session/modelCatalog`、`settings/describe`、`session/create` 和 follow opening 实现 inspect/create 的第一段，不创建探测 Session
- [x] 4.2 先附着 follow 并缓冲 live，再以固定 opening `throughSeq` 调用 `session/page` 到 `hasMore=false`
- [x] 4.3 无损展开 packed chunks，验证 page 进展、seq 覆盖、overlap/gap/required event 与 10,000-page work budget
- [x] 4.4 增加已识别但不产生 CH 输出的 Modern core/profile event schema；只忽略未知 `ignorable: true` event
- [x] 4.5 实现 Adapter 级 `session/control` baseline/update，按 Session/key 保存 value+seq，并立即丢弃未加载 Session 行
- [x] 4.6 对账 follow opening projection 与 control watermark；replacement baseline 整体替换并拒绝同 seq 冲突
- [x] 4.7 实现 follow 断线后的新 snapshot/page repair；不能证明连续时明确 fault
- [x] 4.8 覆盖多页长历史、live buffer、packed row 边界、stale projection、control 重连和 restart resume 测试

## 5. Modern Turn、配置与原生命令

- [x] 5.1 用 client requestId 关联 prompt 与 native Turn；缓冲早到 `turn/start`，并独立投影 unmatched autonomous Turn
- [x] 5.2 投影 text、Reasoning、Tool、Diff、Usage、terminal、Native refs 和 incomplete Turn 恢复
- [x] 5.3 实现 `session/prompt`、`session/cancel`、readSnapshot 与 exactly-once terminal，覆盖 response/event/cancel 竞态
- [x] 5.4 接入 Model/Thinking catalog、`session/selectModel` 和高于调用前 watermark 的 `modelSelection` readback
- [x] 5.5 从 settings 解析 Permission inspect catalog，从 `permissions` control projection 读取 Session options/currentValue并严格对账
- [x] 5.6 通过内部 `/permission` command 选择模式，并等待更高 seq 的精确 projection；exact rc.1 unattended bridge 还必须要求动态 catalog 广告 `danger-full-access` 并以后验 journal 三事实确认 preset/sandbox/approval，显式 Permission 与 unattended 冲突
- [x] 5.7 接入 `commands/list|execute`，证明 #71 compact/goal/plan、active Turn 二次检查和 command 生命周期在 Modern 保持
- [x] 5.8 将 Turn、Model/Permission 和命令的行为测试分别放进引入它们的提交，不延后到统一 test commit

## 6. Modern `$events` 与 Fork

- [x] 6.1 打开 Adapter 级 `$events` 并验证 ready/clientId；只 claim loaded Session 的合法 Approval/Question
- [x] 6.2 对 unloaded agent、未知/不负责的合法 event 发送 `next`；只有 claimed malformed request 才 rejected/fault
- [x] 6.3 以 eventId 复用 Host interaction；replacement generation 重绑定新 clientId，旧结果/重复 replay/cancel 幂等
- [x] 6.4 Session/Adapter detach 前发送 `next`；不可恢复意外断线 best-effort cancel native Turn 后 fault
- [x] 6.5 覆盖双 Client 竞争、next 后他方回答、结构化答案、generation replacement、迟到 response 和 close/fault 收敛
- [x] 6.6 用完整 journal 解析 checkpoint，调用 Modern `session/fork` 并包含 Turn 后到下一 Turn 前的原生配置事件
- [x] 6.7 验证 child ID、parent、cwd、seedLength、raw inherited prefix、`session/end-seed`、checkpoint 和 child-owned refs
- [x] 6.8 覆盖 Fork 后验失败/orphan 诊断且不自动重试

## 7. Review、真实 Gate 与提交整理

- [x] 7.1 由独立子智能体进行协议、并发、安全、认证、恢复和多 Client ownership review，逐项处理发现
- [x] 7.2 由独立子智能体进行过度抽象 review，删除未被两代真实复用的 router、factory、projector 或兼容分支
- [x] 7.3 在隔离安装/DSH_HOME/port 上运行 exact `0.1.1-rc.2` compiled Legacy Gate；未 Gate 旧版本不加入支持矩阵
- [x] 7.4 运行 exact `0.1.2-alpha.4` compiled artifact Gate：version/auth/inspect/create/长历史/Turn/autonomous/Tool/Diff/Usage/restart/cancel/config/interaction/commands/Fork
- [x] 7.5 Gate 覆盖多 `$events` Client、follow/control/$events replacement、secret canary、oversize 和 owned teardown
- [x] 7.6 运行 DeepSeek 聚焦测试、Host/Renderer 命令测试、TypeScript build/typecheck、lint、format、release-package smoke、OpenSpec strict validation 与 `git diff --check`
- [x] 7.7 Windows 本地 Gate 作为阻塞项；Linux/macOS 只有真实 CI/机器通过后才声明，未执行能力明确列为未验证
- [x] 7.8 每个最终行为提交同时携带其测试；开发期 `fixup!` 已在 Draft 前 autosquash，不为提交数量合并不相干行为

## 8. alpha.5 开发期验证与 RC 等待历史

- [x] 8.1 记录 `dsh-v0.1.2-alpha.5`、commit `db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5`、214/214 exact package 与 lock SHA256 `EA51A6EAA1B695BC4490A2C6E206AF74B624501B4543C656F44822035015F288`
- [x] 8.2 审计 alpha.4→alpha.5 的 6 个提交/280 个文件，确认 CH 消费的协议发布产物除版本元数据外逐字节一致
- [x] 8.3 用 raw probe 对照 alpha.4/alpha.5 的 RPC、stream、wire shape 和 19 个关键时序事件，确认 `equivalent=true`
- [x] 8.4 曾将两个 exact alpha release 纳入开发期 selector 并复用同一个 Modern Adapter；没有新增 transport、parser、factory、Session 分支或 semver 范围
- [x] 8.5 在 RC 发布前曾以 alpha.5 作为开发期推荐版本；最终诊断已由第 9 节替换
- [x] 8.6 增加 alpha.4/alpha.5 同路由及其他 prerelease/stable 拒绝的开发期 selector/public Adapter 聚焦测试
- [x] 8.7 通过公开 `DeepSeekHarnessAdapter` 对 exact alpha.5 运行 inspect/create/Model/Thinking/Permission
- [x] 8.8 完成 exact alpha.5 compiled artifact 功能 Gate；wire 超限、secret canary 与异常 carrier 等故障注入由 hermetic tests 覆盖
- [x] 8.9 完成 exact alpha.4 compiled artifact 功能 Gate和 exact rc.2 Legacy Gate；异常 carrier、超限与 secret 故障注入由 hermetic tests 覆盖
- [x] 8.10 对 alpha.5 支持变更进行独立实现与协议 review，并处理发现
- [x] 8.11 运行 `npm run check`、OpenSpec strict、release package smoke 和 `git diff --check`
- [x] 8.12 将 alpha.5 支持以开发期 `fixup!` 提交推送到 fork；alpha 阶段不开 PR、不整理提交，正式 PR 等下一个 DSH RC
- [x] 8.13 对配置端点的 Modern 未认证根页面做严格有界指纹识别，返回双语 `externalModernWeb` 诊断，并证明普通 401/403 不会被误判

## 9. rc.1 收尾、Reasoning、Web 入口与 Draft PR

- [x] 9.1 确认 `dsh-v0.1.2-rc.1` 为 commit `a66e4702047846cdaa10c66c9d3df3951f5ea70d`，alpha.5→rc.1 仅修改 252 个 package version
- [x] 9.2 建立 exact rc.1 隔离 compiled artifact；lock SHA256 为 `37AF94F193173F1E51BCA1A18A5F437649775953BE4A549466F913A869060ED1`，214/214 个 DSH 包均为 rc.1 且没有 nested DSH
- [x] 9.3 最终 selector 只支持 exact rc.2 Legacy 与 exact rc.1 Modern；alpha.4/alpha.5、未知 alpha、未来 rc/stable 全部失败关闭
- [x] 9.4 推荐版本提示中英文各一遍并明确写 `dsh-v0.1.2-rc.1`
- [x] 9.5 目标 endpoint 指纹验证只访问默认 3080 或显式配置端点；不扫描、发现或影响其他端口上的 DSH
- [x] 9.6 provisional `reasoning-delta` 不进入 append-only Host Item；最终 `assistant/message` 一次发布权威 Reasoning，正文继续严格流式
- [x] 9.7 覆盖 Reasoning 尾部换行、中段改写、多 Turn、历史恢复、follow replacement 与正文前缀失败测试
- [x] 9.8 通过公开 Adapter 对 exact rc.1 运行 raw probe、inspect/create、长历史、多 Turn/Reasoning、配置、恢复、交互、Fork 与 teardown Gate
- [x] 9.9 为 CH-owned local Modern DSH 提供设置页 Web 打开动作，且 Legacy、外部 DSH、remote Host、关闭进程均不显示或拒绝
- [x] 9.10 验证 Web URL ownership、严格 loopback、token 不进入 Renderer/RPC/诊断、关闭清理和重复点击
- [x] 9.11 运行 DeepSeek/Host/Renderer/平台聚焦测试、TypeScript build/typecheck、lint/format、OpenSpec strict、release smoke 与 `git diff --check`，不运行全仓测试
- [x] 9.12 rebase 到 codexhost v0.4.4，以 range-diff/tree diff 审查重写，并逐文件确认相对 base 无越界修改
- [x] 9.13 将开发期提交整理为 20 个逻辑提交，每个行为携带测试并保留 #71 的四个来源
- [x] 9.14 推送 fork 并创建详细 Draft PR；正文写明 `Supersedes #71 per prior discussion with the owner.`
- [x] 9.15 用户在 Windows 实机点击设置页动作，确认 `ShellExecuteW` 在默认浏览器打开已认证的 DSH Web，而不是回退打开文件夹

# Proposal

## Why

Windows 更新页目前只提供手动更新，已有后台更新链路在安装身份、进程交接和失败恢复方面存在缺口。恢复 Windows 的一键更新，同时保持用户已确认正常工作的 macOS npm、DMG 更新行为不变。

## What Changes

- Windows npm 和安装包用户均可在现有更新页执行“更新并重启”，保留原安装方式、安装位置和手动更新入口；不增加安装器关闭提示或确认页。
- 退出前完成固定目标版本的下载、校验、安装归属验证和恢复准备；npm 不再等应用退出后才联网获取包。
- 修复 Windows Updater 识别和更新锁交接，覆盖 Desktop、独立控制台和终端更新入口；只停止当前安装拥有的进程。
- Windows 安装或启动失败时，利用原安装渠道的本地材料尝试恢复旧版本并报告结果。只有目标版本、当前安装和本次新启动实例就绪，才报告成功；恢复失败保留材料及手动修复入口。
- 增加真实 Windows 文件占用、进程交接、断网安装和失败恢复测试，覆盖新更新器自身的升级路径；macOS 两条现有路径作为回归保护。

## Decisions

- 保留 GitHub 最新稳定 Release 作为版本来源，并锁定其精确版本；npm 用户使用对应 npm 包，不改成浮动 `latest`，不跨发行方式迁移。
- 保留一套公共更新协调逻辑，按 npm、Windows 安装包、macOS App 分渠道执行；npm 共用原流程，只局部处理 Windows 差异。不复制整套 Windows 更新系统，不引入通用更新框架。
- 优先复用现有请求、状态和启动记录，只为经验证的缺口补充必要字段或探测。保持 macOS/Linux 可观察行为，不以此禁止修改有回归测试保护的共用代码。
- 保留退出前预下载和校验，不要求每次更新先在临时位置完整试装。安装与恢复优先使用原生工具，不手工镜像 npm 元数据、卸载注册信息或快捷方式。
- 本期保留运行中可捕获的安装/启动失败恢复；任意阶段崩溃或断电后的自动恢复、独立恢复命令及完整事务日志不在范围内。异常中断保留材料和诊断供手动修复，不宣称自动恢复保证。无法验证安装归属或准备恢复材料时不停止旧应用。
- 用户点击“更新并重启”即授权准备完成后重启当前受管实例；不新增自动静默重启、Harness 空闲调度、差分下载或灰度发布能力。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `github-release-background-update`：增加 Windows 的安装身份约束、离线可安装准备、可靠交接、目标启动确认和有界失败恢复；保留其他平台现有行为与版本来源。

## Impact

- `packages/update-manager`：Windows 准备、npm 来源识别、操作锁及恢复状态。
- `packages/host-runtime`、`packages/console-server`、`packages/renderer-extension`：入口协调、Windows 按钮、结果与恢复展示。
- `crates/launcher`、`crates/updater`、`crates/platform`：Windows 进程生命周期、原渠道安装与恢复、现有启动信息的验证；仅在已有信息不足时扩展 `packages/desktop-control` 的就绪探测。
- 不预设 Windows 专属请求格式或新回执协议；实际字段变更仍须严格校验并处理兼容，不向 Renderer 开放路径、命令或下载地址输入。
- Windows 安装打包与测试、现有控制台更新文档。复用 PR #640 的目标安装进程关闭能力，实施时核对其合并或分支依赖，不重复实现。

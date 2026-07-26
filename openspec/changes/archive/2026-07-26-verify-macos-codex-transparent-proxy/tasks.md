## 1. 保护现有行为并划分生产与 Gate 边界

- [x] 1.1 在当前 Mac 按固定 Node/npm/Rust 版本执行 `npm ci`、`npm run check` 和 `npm run build`，记录不含本机敏感路径的代码、macOS、架构、Desktop 和 CLI 基线
- [x] 1.2 为现有共享 Shim 行为补齐平台无关回归用例，覆盖原 argv/env、明确目标、递归、任意字节与 chunk、LF/CRLF、EOF、stderr、普通退出码和大输出
- [x] 1.3 审计 `launcher`、`shim`、`platform` 与 `tools/gate-a`，形成代码内清晰边界：安装/启动/监督/透明代理为生产候选，Capture/脱敏/差分/Gate 报告为显式测试设施
- [x] 1.4 调整 Gate-only 配置，使未显式启用 Probe 时 Launcher/Shim 不写调用记录或 Gate 报告，且透明代理核心不依赖 Capture 状态
- [x] 1.5 在开始平台重构前运行并保存 Windows hermetic 回归结果，确保后续能检测 Windows Job Object 和 Shim 行为退化

## 2. 提取跨平台代理与进程监督契约

- [x] 2.1 重构 Shim，将官方 CLI 路径校验、argv 转发、stdio 字节泵、EOF 半关闭、输出排空和退出分类整理为 Windows/macOS 共用核心，不复制 macOS `run_proxy` 路径
- [x] 2.2 在 `platform` 中定义满足 spawn 前隔离、正常等待、温和终止、超时升级和身份复核的内部进程监督契约，不引入 Host Thread/Harness 类型
- [x] 2.3 让现有 Windows 实现适配新监督契约并继续使用 kill-on-close Job Object，覆盖 Shim 正常退出和强制终止后的子树清理
- [x] 2.4 为共享监督契约增加可控假 CLI/孙进程测试，验证 Close、EOF、Crash 和并发终态只收敛一次
- [x] 2.5 运行 Windows/macOS 可运行的 Rust、TypeScript 和差分 hermetic 测试，确认共享重构未改变既有 Windows Fixture 与 stdout 纯净性

## 3. 实现生产候选的 macOS 安装与进程发现

- [x] 3.1 在 `platform` 中实现 macOS App bundle 只读发现，解析 `Info.plist` 并验证 `com.openai.codex`、版本、`CFBundleExecutable` 和同 bundle 的 `Contents/Resources/codex`
- [x] 3.2 校验 Desktop/CLI 为存在且可执行的规范化 Mach-O 路径，拒绝符号链接递归、缺失目标和 `PATH`/Homebrew/全局 `codex` 回退
- [x] 3.3 定义多个合法 App 候选的确定性选择或歧义错误规则，并为标准安装、用户 Applications、错误 Bundle ID、缺失 CLI 和多候选建立临时 App bundle Fixture 测试
- [x] 3.4 使用 macOS 原生进程 API 实现 PID、父 PID、process group 和规范化可执行路径快照，不通过正式运行时代码解析 `ps` 或 Linux `/proc`
- [x] 3.5 实现按目标 bundle root 识别 Desktop 主进程和相关后代的逻辑，覆盖同名非目标进程、权限受限进程和 PID 身份变化
- [x] 3.6 更新 `launcher inspect` 输出为跨平台安装信息，并保持 Windows package 信息与 macOS bundle 信息各自可诊断而不互相伪造

## 4. 实现生产候选的 macOS 进程组、信号与有界清理

- [x] 4.1 在官方 CLI spawn 前建立独立 process group 或等价隔离边界，消除 spawn 后设置 group 的竞态
- [x] 4.2 实现受限 Unix 信号接收与主监督循环唤醒，使 `SIGTERM`、`SIGINT`、`SIGHUP` 和实测取消信号由串行清理逻辑处理
- [x] 4.3 实现 macOS 温和终止、有限宽限等待、强制终止、stdout/stderr 排空和最终进程身份复核
- [x] 4.4 实现外层 Launcher 对本次 Desktop/Shim/CLI 进程集合的监督，使 Shim 被强制终止时仍能清理由本次启动创建的后代
- [x] 4.5 在发送破坏性信号前复核 PID、可执行路径和启动关系，PID 复用或身份冲突时拒绝误杀并返回明确诊断
- [x] 4.6 增加 macOS hermetic tests，覆盖普通退出、非零退出、stdin EOF、CLI Crash、`SIGTERM`、`SIGINT`、Shim `SIGKILL`、忽略温和信号、孙进程逃逸尝试、超时升级和无孤儿进程
- [x] 4.7 审计新增依赖和必要 `unsafe`，将原生调用限制在 `platform` 私有模块，并通过 rustfmt、Clippy 和故障测试

## 5. 验证并选择 macOS Desktop 生产启动路径

- [x] 5.1 为 Gate 增加显式的 LaunchServices 与直接 bundle 主程序两种 Probe 模式，两者均只设置本次启动环境且不得修改 `launchctl` 全局环境、官方 App 或用户配置
- [x] 5.2 在目标 Desktop 已运行时验证两种 Probe 都拒绝复用或终止现有实例，并给出可操作诊断
- [x] 5.3 正常关闭现有 Desktop 后执行 LaunchServices 隔离 Capture，记录返回进程、实际 Desktop PID、单实例行为、进程关系、process group 和 Shim 环境继承结果
- [x] 5.4 执行 bundle 主可执行文件隔离 Capture，记录相同证据并验证窗口、Dock/菜单、单实例、正常退出和错误传播是否保持可接受行为
- [x] 5.5 根据证据选择唯一生产候选启动路径；若两者均不成立则生成 `FAIL`/`BLOCKED` 证据并停止将环境继承假设固化到正式 Launcher
- [x] 5.6 将选定路径实现到 `platform`/`launcher` 的生产候选 API，Probe 仅通过显式选项增加 Capture，不维护第二套启动逻辑
- [x] 5.7 固化真实 Desktop 调用的 argv、cwd、环境键存在性和进程关系脱敏 Fixture，确认 app-server 参数分类并记录未观察到的调用类型

## 6. 平台化 Gate 证据、Schema 和差分基础

- [x] 6.1 将 Probe Invocation、Interactive Evidence 和 Gate Report Schema 改为共享字段加 Windows/macOS 判别联合，保留既有 Windows Fixture 的校验与语义
- [x] 6.2 将本地原始证据和可提交 Fixture 按平台分区，更新 Git 忽略规则并测试 macOS 运行不会覆盖 Windows 资产
- [x] 6.3 扩展确定性脱敏器，处理 macOS bundle、用户目录、临时目录、进程参数和签名摘要，增加凭据、Prompt、Transcript、Tool 输出和绝对路径正反例
- [x] 6.4 平台化 `tools/gate-a` preflight/probe/differential/finalize 编排，为 macOS 增加独立 npm Gate 命令且保证普通 `npm run check` 不启动真实 Desktop
- [x] 6.5 复用官方 CLI 直连/Shim 差分运行器，补齐 POSIX 路径与退出分类的最小归一化，保持未知差异和非 JSON stdout 默认失败
- [x] 6.6 使用 App bundle 内官方 CLI 执行 `--version`、初始化、Model、Thread 新建/读取/继续、未知 Method 等非 live 差分，并人工评审所有归一化项
- [x] 6.7 使用隔离 `CODEX_HOME` 和专用测试 Prompt 执行流式、只读工具/继续和取消 live 差分，只提交脱敏布尔摘要

## 7. 执行真实 macOS Desktop Gate A

- [x] 7.1 通过选定 Launcher/Shim 路径启动全新 Desktop，确认 `Desktop → Shim → App bundle 官方 CLI` 调用链、进程级环境和 stdout 协议纯净性
- [x] 7.2 在专用测试 Thread 验证新建、流式回复、只读工具执行、继续和取消，并与官方直连行为比较
- [x] 7.3 验证 Desktop 正常退出、父 stdin EOF、官方 CLI Crash 和温和信号时的退出分类、输出排空与进程树清理
- [x] 7.4 验证 Shim 强制终止和 Desktop 强制终止时外层监督能够在有界时间内清理本次 Probe 的 CLI 与后代
- [x] 7.5 每个生命周期场景结束后按可执行路径、PID 关系和 process group 检查无 Probe 孤儿进程，不把用户原有无关 Codex 进程计入或清理
- [x] 7.6 生成包含 macOS、架构、Desktop、CLI 和代码版本的本地 Gate 报告，根据完整证据标记 `PASS`、`FAIL` 或 `BLOCKED`
- [x] 7.7 生成 `docs/macOSCodex透明代理验证记录.md` 和经过人工隐私复核的 macOS Fixture；报告非 `PASS` 时明确失败阶段、影响、解除条件或下一架构决策

## 8. 质量、回归与范围验收

- [x] 8.1 在 macOS 执行 `npm run check`、`npm run build`、独立 macOS Gate 命令及所有相关 Rust integration/differential tests
- [x] 8.2 确认 Windows CI 和现有 Windows hermetic/Fixture 测试继续通过，且 macOS 改动没有把 Job Object 语义替换为 POSIX 模拟
- [x] 8.3 审计提交内容不包含 `.codexhost/` 原始证据、完整环境、凭据、Prompt、Transcript、Tool 输出、日志、下载文件或用户绝对路径
- [x] 8.4 核对生产候选 Rust 路径不依赖 Probe Capture，并确认本变更未实现 Pi RPC、Protocol Core、Renderer、Mapping Store、安装器、签名、公证或发布打包
- [x] 8.5 将 macOS Gate 结论和已验证平台边界更新到 `docs/开发步骤清单.md`；只有报告为 `PASS` 时才勾选对应 Gate 项
- [x] 8.6 运行 `openspec validate verify-macos-codex-transparent-proxy`，确认每项 Requirement 和场景都有实现、自动化测试或带版本的真实 Gate 证据

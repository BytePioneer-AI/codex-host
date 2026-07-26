## 1. Probe 安全基线与测试入口

- [x] 1.1 定义 Probe 配置、调用记录、脱敏 Fixture 和 Gate 报告的版本化结构，字段采用最小 allowlist
- [x] 1.2 为原始捕获、临时日志、差分输出和本机路径增加 Git 忽略规则，并验证不会进入版本控制
- [x] 1.3 建立可控的假 Codex CLI 测试程序，支持 argv/env 回显、任意 stdout/stderr chunk、EOF、退出码、延迟和子进程场景
- [x] 1.4 增加独立 Windows Gate 命令和前置环境检查，确保普通 `npm run check` 不启动 Codex Desktop

## 2. Windows 安装、进程与路径发现

- [x] 2.1 在 `platform` 中实现 Windows Codex Desktop 安装发现并返回版本化、规范化的安装信息
- [x] 2.2 实现目标 Desktop 进程检测；已有实例时拒绝复用或终止，并返回可操作诊断
- [x] 2.3 实现与当前 Desktop 安装对应的官方 Codex CLI 发现，拒绝静默回退到任意全局 `codex`
- [x] 2.4 实现 Shim/官方 CLI 路径规范化和同路径递归校验，并用临时路径、缺失文件和同路径用例测试

## 3. Launch Probe 与调用事实采集

- [x] 3.1 在 `launcher` 中实现只影响本次启动的环境构造，设置绝对 Shim 路径和明确的官方 CLI 路径
- [x] 3.2 实现受支持的 Windows Desktop 新实例启动路径，并验证不会修改用户/系统环境、官方安装或 `app.asar`
- [x] 3.3 在 `shim` Probe 模式记录 argv、cwd、allowlist 环境键存在性、进程关系和退出分类，stdout 不写诊断
- [x] 3.4 实现确定性路径/敏感值脱敏器及正反例测试，原始捕获只写入已忽略目录
- [x] 3.5 关闭现有 Desktop 后执行真实 Launch Probe，记录 Desktop/CLI/Windows 版本并生成首份人工检查后的调用 Fixture
- [x] 3.6 根据真实 Fixture 固化 app-server/非 app-server 参数分类；若环境继承或调用未成立，记录 FAIL/BLOCKED 证据并停止把该假设用于正式模块

## 4. 实验性透明 Shim

- [x] 4.1 按捕获到的原 argv 启动明确的官方 CLI，并在子进程环境中清除或重写 `CODEX_CLI_PATH`
- [x] 4.2 实现父 stdin 到子 stdin、子 stdout 到父 stdout 和子 stderr 到父 stderr 的并发字节泵，不解析或规范化换行
- [x] 4.3 实现父 stdin EOF 后关闭子 stdin并继续排空输出的半关闭行为，覆盖子进程先退出和大输出场景
- [x] 4.4 映射正常退出码和启动/崩溃失败，确保 Shim 错误只进入 stderr 且 stdout 保持协议纯净
- [x] 4.5 在 `platform` 中实现 Windows 有界进程树清理，覆盖取消、Shim 终止、超时升级和无孤儿进程
- [x] 4.6 使用假 CLI 完成 argv/env、递归、任意 chunk、EOF、stderr、退出码、崩溃、取消和进程树 hermetic 测试

## 5. 官方 CLI 差分与脱敏 Fixture

- [x] 5.1 建立官方 CLI 直连与 Shim 链路差分运行器，对两侧使用相同的无敏感测试输入和隔离配置
- [x] 5.2 定义并评审动态 ID、时间和本地路径的最小归一化清单，未知差异默认失败且不得自动覆盖 Golden
- [x] 5.3 采集并人工检查官方 app-server 脱敏 Fixture，确认不包含凭据、真实 Prompt、完整用户消息或本地绝对路径
- [x] 5.4 对初始化、Thread 新建/读取/继续、流式消息、工具、取消和错误执行可自动化的官方 CLI 差分
- [x] 5.5 验证字节转发层输入输出完全一致，并为发现的每个协议差异记录分类、证据和 Gate 影响

## 6. 真实 Desktop Gate A 验收

- [x] 6.1 通过实验 Launcher/Shim 启动全新 Codex Desktop，确认实际调用链、进程树和 stdout 协议纯净性
- [x] 6.2 在专用测试 Thread 验证新建、继续、流式回复和工具调用，并与官方直连观察结果比较
- [x] 6.3 验证用户取消、Desktop 正常退出、stdin EOF、官方 CLI 崩溃和 Shim 终止时的终态与进程树清理
- [x] 6.4 生成带 Desktop、Codex CLI、Windows 和代码提交版本的 Gate A 报告，明确标记 PASS、FAIL 或 BLOCKED
- [x] 6.5 Gate 非 PASS 时记录失败阶段、核心不变量影响和下一产品/架构决策，禁止把 Windows 透明代理标记为已验证

## 7. 质量与范围验收

- [x] 7.1 运行格式、Lint、类型、Rust Clippy、单元测试、差分测试和构建，并确认普通检查不依赖真实 Desktop
- [x] 7.2 审计提交内容不包含原始捕获、凭据、Prompt、Transcript、下载文件、日志或本地配置
- [x] 7.3 核对本变更未实现 Pi RPC、Protocol Core 转换、Renderer 注入、Mapping Store、安装器或 macOS Gate
- [x] 7.4 运行 `openspec validate verify-windows-codex-transparent-proxy` 并确认每项 Gate 要求都有对应实现、测试或验证记录

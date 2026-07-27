## 1. 收敛现有 Gate B 实现

- [ ] 1.1 按新设计审计当前改动，列出可保留的 CDP、Shim/Observer、JSONL 和进程基础，以及应删除的多草稿、synthetic cwd 归属、复杂 Capture 审批和五场景报告代码
- [ ] 1.2 删除 Gate B 对 `CreateRequestId`、per-Composer draft registry、双草稿并发和 Response 反序的产品依赖，保留只为透明 Request/Response 所需的 JSON-RPC `id`处理
- [ ] 1.3 将开发环境检查收敛为 Node.js 24 和可用 Rust 工具链，删除 npm 版本门禁；Gate 发现已运行 Desktop 时允许停止、终止、按本次配置重启或在配置可确认时复用

## 2. 真实 Renderer seam Capture

- [ ] 2.1 记录并按需要停止或终止当前 Codex Desktop，使用进程级 remote debugging 启动受控实例；若现有实例已满足本次配置则直接复用，并通过 direct CDP 确认 Renderer target
- [ ] 2.2 参考 CodexPlusPlus 的动态模块包装行为，捕获当前 Desktop 首次发送经过的 `start-conversation`、app-server client、dispatcher或 bridge 候选调用形状
- [ ] 2.3 选择一个能在调用原函数前修改真实创建参数的 seam，记录 Desktop/CLI 版本、Method、参数传播位置和健康检查；不能修改时记录 `BLOCKED`或`FAIL`

## 3. 当前 Harness 选择与 Request 装饰

- [ ] 3.1 在当前 Renderer document 注入最小 Codex/Pi 控件，默认值明确，切换不创建 Thread、不启动 Pi且不发送独立业务消息
- [ ] 3.2 在已确认 seam 的创建调用发生时读取当前最终选择，并把 Gate-local `harnessId`写入同一个真实创建 Request
- [ ] 3.3 保持非创建调用不变，并在 document 重载后重新注入且不复用旧 document 选择
- [ ] 3.4 增加当前选择、发送时最终值、Request 字段装饰、非创建透明和重载默认值的最小 Hermetic 测试

## 4. Observer 路由事实验证

- [ ] 4.1 保留 Shim 仅对显式 Gate B `app-server`调用进入 Observer，其他 CLI 调用继续透明进入当前安装对应的官方 CLI
- [ ] 4.2 让 Observer 校验 Codex/Pi `harnessId`并在任何官方转发前移除 Gate 扩展；无关 JSONL line 保持内容和顺序
- [ ] 4.3 Codex 选择继续官方 app-server；Pi 选择在成为普通 Codex 创建或 Turn 前返回受控 Gate 结果，不创建官方影子 Thread
- [ ] 4.4 增加 Codex 转发、Pi 阻止、缺失/非法 Harness、扩展移除和诊断不包含 Prompt 正文的测试

## 5. 真实 Gate 与收口

- [ ] 5.1 运行一次选择 Codex 的真实创建尝试，确认移除 Gate 字段后官方创建仍可用
- [ ] 5.2 运行一次选择 Pi 的真实创建尝试，确认同一真实 Request 到达 Observer 且没有进入官方 Codex Agent Loop
- [ ] 5.3 生成窄范围 `PASS`、`FAIL`或`BLOCKED`记录，只保存版本、实际 seam、字段位置和两条路由结果，不声称 Pi 已执行
- [ ] 5.4 运行最窄 Gate B 测试、Gate A Shim 回归、`npm run check`、`npm run build`和 strict OpenSpec validation，记录实际通过、跳过或阻塞结果
- [ ] 5.5 Gate `PASS`后停止扩建 Gate 基础设施，转入开发清单定义的最小 Codex/Pi 对话垂直链路

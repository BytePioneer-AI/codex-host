## 1. Claude Adapter包与Transport

- [x] 1.1 新增`@codexhost/adapter-claude-code` workspace包、Project Reference和精确生产依赖
- [x] 1.2 实现用户安装Claude可执行文件解析、SDK Query输入队列和可注入Fake Transport边界
- [x] 1.3 实现partial/full Assistant文本去重、完整Result分类和开放unknown事件处理
- [x] 1.4 为Transport添加Hermetic测试，覆盖无partial补齐、冲突文本、success+error、认证错误和cancel终态

## 2. Claude HarnessSession

- [x] 2.1 实现惰性open、首Turn Query初始化、Native Session Ref和同Query多Turn复用
- [x] 2.2 实现共享Agent Message lifecycle、busy/rejection和唯一成功/失败终态
- [x] 2.3 实现`turn.cancel`、Result收敛、取消后继续及close/fault竞态
- [x] 2.4 添加Fake Transport契约测试，证明普通测试不启动Claude或读取用户配置

## 3. 注册式Protocol与Host路由

- [x] 3.1 扩展Protocol Core有限transport注册表，支持Pi与Claude Code并保持官方Model透明
- [x] 3.2 将Host的Pi专用Thread/Adapter字段泛化为External Harness注册表和统一Thread实现
- [x] 3.3 复用统一Projector、响应Gate、read/name/delete/close逻辑并对未注册token fail closed
- [x] 3.4 扩展Route Observation和Host测试，覆盖Codex、Pi、Claude双Adapter隔离与响应顺序

## 4. 运行时组合与默认边界

- [x] 4.1 在Host composition root始终注册Pi，并仅在显式环境开关下注册Claude Code
- [x] 4.2 保持默认Agent为Codex/Pi并从官方Codex子进程环境移除Claude内部控制变量
- [x] 4.3 更新package metadata、TypeScript references、边界测试和锁文件

## 5. 受控Renderer注册

- [x] 5.1 将Renderer Agent控件改为显式enabled列表，默认仍为Codex/Pi
- [x] 5.2 复用同一Model atom和Composer状态机映射Claude transport token
- [x] 5.3 将标题隔离泛化为所有非Codex Harness并保持Pi现有计数
- [x] 5.4 为Renderer、Desktop Control和binding runner添加显式`--enable-claude-code`及脱敏测试

## 6. 真实纵向验证

- [x] 6.1 添加显式真实Claude Adapter Live测试，验证文本、多Turn、Cancel和有界close
- [x] 6.2 运行Fake双Adapter Host纵向测试及真实Claude到Host JSON-RPC投影Gate
- [ ] 6.3 运行真实Codex Desktop受控Gate，验证Claude选择、流式文本、取消和同Thread继续
- [x] 6.4 保存脱敏验证结论，不记录Prompt、Transcript、完整ID、账号或本地绝对路径

## 7. 完成检查

- [x] 7.1 运行Prettier、ESLint/边界、TypeScript typecheck、全量Vitest和Renderer build
- [x] 7.2 运行`npm run check`、`npm run build`和全部OpenSpec strict validation，记录Rust或环境阻塞
- [x] 7.3 审计默认Renderer不展示Claude、Codex/Pi行为无回归且Claude SDK类型未穿透Adapter

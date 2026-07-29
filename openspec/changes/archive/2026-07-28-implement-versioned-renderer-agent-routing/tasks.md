## 1. Composer Agent锁定

- [x] 1.1 扩展AgentSelectionRegistry，支持draft/locked状态、首次输入锁定和DOM replacement状态传递
- [x] 1.2 更新Agent控件，在Adapter ready前禁用Pi，并在首次beforeinput后锁定控件
- [x] 1.3 增加Composer隔离、锁定、替换和非法切换测试
- [x] 1.4 使用不透明Model target区分首次创建replacement、新任务和其他Conversation

## 2. 版本锁定Renderer与主进程Adapter

- [x] 2.1 定义最小Adapter契约、当前Desktop build签名和脱敏安装状态
- [x] 2.2 唯一定位当前Composer的optimistic/committed Model atom，并同步写入Pi transport状态
- [x] 2.3 对Codex snapshot恢复、Pi状态、结构不匹配和Composer歧义增加测试
- [x] 2.4 将Adapter安装接入Inspector注入流程，失败时保持Pi fail closed
- [x] 2.5 绑定主进程metadata service与所属webContents，Pi标题使用本地fallback

## 3. Host预热资源收敛

- [x] 3.1 将Pi Thread归属建立与PiRpcSession启动分离，首个turn/start才启动Session
- [x] 3.2 保证同Thread后续Turn复用Session，未消费预热Thread不产生Pi子进程
- [x] 3.3 增加多预热Thread、首Turn失败、后续Turn和Host关闭测试

## 4. 真实链路验证

- [x] 4.1 扩展脱敏Host观察，区分全部thread/start carrier并用匿名ordinal关联最终消费Thread
- [x] 4.2 在当前Desktop build验证Codex official-model、Pi pi-transport和Pi标题本地fallback
- [x] 4.3 验证页面选择Pi后创建一个真实Pi Native Session并在同一Codex Thread显示回复
- [x] 4.4 验证新建Codex/Pi、输入后切换阻止、Renderer重载、结构不匹配和进程清理
- [x] 4.5 验证同一Pi Thread后续Turn无新create并复用同一Native Session

## 5. 收口

- [x] 5.1 更新受影响文档与验证记录，不把内部transport token表达为实际Model
- [x] 5.2 运行strict OpenSpec validation、npm run check、npm run build和git diff --check

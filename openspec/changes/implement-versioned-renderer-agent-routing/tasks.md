## 1. Composer Agent锁定

- [x] 1.1 扩展AgentSelectionRegistry，支持draft/locked状态、首次输入锁定和DOM replacement状态传递
- [x] 1.2 更新Agent控件，在Adapter ready前禁用Pi，并在首次beforeinput后锁定控件
- [x] 1.3 增加Composer隔离、锁定、替换和非法切换测试

## 2. 版本锁定Renderer Adapter

- [x] 2.1 定义最小Adapter契约、当前Desktop build签名和脱敏安装状态
- [ ] 2.2 定位当前build的enqueue前prewarmThreadStart实例，并以克隆参数装饰Pi transport model
- [ ] 2.3 对Codex透明、Pi装饰、结构不匹配、安装过晚和Composer歧义增加测试
- [ ] 2.4 将Adapter安装接入Inspector注入流程，失败时保持Pi fail closed

## 3. Host预热资源收敛

- [x] 3.1 将Pi Thread归属建立与PiRpcSession启动分离，首个turn/start才启动Session
- [x] 3.2 保证同Thread后续Turn复用Session，未消费预热Thread不产生Pi子进程
- [x] 3.3 增加多预热Thread、首Turn失败、后续Turn和Host关闭测试

## 4. 真实链路验证

- [ ] 4.1 扩展脱敏Host观察，区分全部thread/start carrier并关联最终消费Thread而不保存完整ID
- [ ] 4.2 在当前Windows Desktop先验证Codex official-model与Pi pi-transport全部创建请求
- [ ] 4.3 验证页面选择Pi后创建一个真实Pi Native Session并在同一Codex Thread显示回复
- [ ] 4.4 验证新建Codex/Pi、输入后切换阻止、Renderer重载、版本不匹配和进程清理

## 5. 收口

- [ ] 5.1 更新受影响文档与验证记录，不把内部transport token表达为实际Model
- [ ] 5.2 运行strict OpenSpec validation、npm run check、npm run build和git diff --check

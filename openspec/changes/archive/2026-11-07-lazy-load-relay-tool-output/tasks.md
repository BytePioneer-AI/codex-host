# Tasks

## 2. 审查修正

- [x] 2.1 实时事件透传，快照/分页预算按最新优先分配且返回顺序不变；补实时无扫描及最新输出保留全文的测试。
- [x] 2.2 全文读取接入生成的 session/toolOutput Remote 描述符和 SessionRemotes，移除手写 HTTP 信封；验证缓存去重、错误与真实浏览器调用。
- [x] 2.3 预览和全文均复用正常 Tool view，卡片底部增加带大小的轻量操作，复用原有复制控件并先取全文；验证单一复制入口、加载/失败/版本提示、阅读锚点，更新手机截图和字节结果并重跑原检查。

## 1. 中转工具输出按需读取

- [x] 1.1 将 `RequestTrust.relaySockets` 的可信中转标记从 HTTP/upgrade 显式传入 RPC 与 stream 上下文；扩展 transport/relay 定向测试，验证官方及自建路径有效、直连/局域网/Tailscale/反代和伪造请求头不触发，认证与撤销行为不变。
- [x] 1.2 建立现有 capText() 后投影文本解析、带日志代次的工具身份/内容指纹及连接级发送转换；服务端测试覆盖 64 Ki 单项阈值、8 Ki 预览、128 Ki 窗口预算及边界、多中项超预算、snapshot/resume/page、活动回合完整和直连并行读取不受污染。
- [x] 1.3 新增授权全文 RPC 与浏览器安全契约，复用 external 会话所有权及精确条目查找；定向测试覆盖成功、全文与本地现有裁剪输出一致且不绕过 100,000 字符上限、版本错误、跨会话引用、未知目标、非 external/不可见会话、未认证及撤销后拒绝。
- [x] 1.4 接入 Session Controller 的按身份版本去重缓存、工具卡片与原始输出的原地展开及复制全文能力，补中英文 locale；Vitest 与隔离浏览器测试验证加载、失败重试、版本失效提示、复制先取全文、同版本不重复请求、版本变化不复用与阅读锚点不跳动。同步更新现有产品文档，说明仅中转预览、活动回合完整和全文读取约束。
- [x] 1.5 用隔离 fake Host/Web 中转测试环境统计固定大输出首屏整个响应的前后 UTF-8 字节及同口径压缩字节，包含引用/元数据且排查隐藏全文副本；保存手机宽度“显示完整输出”截图至任务 scratchpad 的 `history-sync-tool-output-mobile.png`，交付汇报列出实测数值和截图绝对路径。
- [x] 1.6 按改动范围运行相关 Web 单测、Session Controller/UI 的定向 Vitest 和隔离浏览器测试，执行覆盖相关包的 `npx tsc -b`、`npx tsc -p tests/tsconfig.json`、`npm run lint` 与 OpenSpec 校验；记录实际执行和阻塞，不运行用户服务 start/stop，不改 `design-prototypes/`，不提交。

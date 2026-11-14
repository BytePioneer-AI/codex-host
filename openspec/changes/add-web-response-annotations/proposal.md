# Proposal

## Why

Codex Desktop 允许在回复里选中文字后「Add to chat」，把这段文字作为批注挂到下一条消息上。Web 版没有这个入口，手机或浏览器远程使用时拿不到同样的能力。

## What Changes

- Web 会话的回复中选中文字时，在选区旁显示「Add to chat」；点击后把选中文字挂到当前 Composer，可按顺序叠加多条、逐条移除。选中文字保留段落与代码行的换行。
- 挂上的批注在 Composer 上方以编号芯片显示，点开可见完整选中文字。
- 发送时批注进入消息正文，格式与 Codex Desktop 相同：一条 `# Response annotations:` 前缀区块（含结构化条目与使用说明），后接 `## My request:` 与用户正文。只有批注、没有正文的消息同样可以发送。
- 已发送的消息不再显示原始区块：气泡只显示正文，批注以上述芯片呈现；刷新或重新打开历史同样如此。
- 回复里的原生指令 `:codex-annotation{index="N"}` 显示为「批注 N」，点开可见对应选中文字；行内代码、代码块与转义示例保持原文，作为指令识别但序号不合规或找不到对应批注时不显示任何内容。

## Decisions

- 复用 Codex Desktop 的提示文本格式，不另造字段：批注随消息正文一起发给 Harness，因此同一 Thread 在 Desktop 与 Web 看到的消息与历史一致，Host、协议与持久化都不改动。就相同的条目与正文而言，该文本按 Desktop 自带拼装函数的实际输出逐字节比对，包含说明文字里的标点与正文后的结尾换行；真实选区本身另按 Desktop 的选区提取规则对齐并比对。
- 省略 Desktop 批注里的来源定位字段（`source`）。Desktop 用 Codex 原生 item id 与该回复渲染出的 DOM 文本偏移定位；Web 侧的 item id 由 Adapter 生成、DOM 也不同源，写近似值会与 Desktop 冲突，因此不写。Desktop 的原生解析允许条目缺少该字段，但 Web 消息确实不提供这个来源定位。
- 批注不进编辑器草稿正文：草稿同样保持干净，批注是独立的会话输入状态，发送时才拼成前缀；发送失败时正文与批注按发送先后一起回到 Composer。
- 流式中的回复不提供入口，完成后的回复可以。入口在桌面视口画在选区上方并按自身宽度收到视口内，触摸视口画在选区下方，让手机系统菜单在上方可用。
- 指令在 Markdown 语法层识别，而不是对已解析文本做替换：行内代码、代码块、转义与链接文字因此保留各自的语义，可选指令标签与连续属性片段完整消费，属性取值沿用原生词法；固定词法样例与 Desktop 安装包实际输出逐条核对。
- 悬浮层只做「Add to chat」。同一浮层里的 Ask in side chat、Comment、Edit、More details 不在本次范围。

## Capabilities

### New Capabilities

- `web-response-annotations`: 选中回复文字附加批注、与 Desktop 一致的发送格式、以及发送后的展示。

### Modified Capabilities

无。Host 接口、Session 事件与持久化格式均不变。

## Impact

- `apps/web-ui`：Composer 输入状态与附件区、回复选区浮层、Markdown 的批注引用渲染、已发送消息展示；`packages/shared-contracts` 增加批注区块的拼装、解析与引用序号校验。
- 不触碰 Host、协议、Adapter、持久化；不新增 RPC、存储或依赖。
- 同步 `docs/product/standalone-web.md` 的当前行为说明。

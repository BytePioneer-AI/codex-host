# 外部 Thread 的本地图片显示

外部 Harness 的消息由 codexhost 投影成 Codex Desktop 原生条目后显示。本地图片能否显示，取决于投影出的条目是否满足 Desktop 的加载规则。本文记录当前做法和边界，依据 Codex Desktop 26.1021.3705.0 与 26.1027.51404 的渲染代码核对；Desktop 更新后需重新核实。

## Desktop 的加载规则

Agent 消息中的 Markdown 图片（`![alt](目标)`）只有在目标是绝对路径（`/…`、`C:\…`、`C:/…`、UNC）或 `file:` URL 时，才会被当作本地文件，经 app-server 读取后显示。其他目标按 Desktop 页面自身地址解析，加载失败后显示“Image unavailable”占位框。只有预览 `.md` 文件时，Desktop 才会按该文件所在目录补全相对路径；对话消息没有这个基准目录。

Harness 常按工作目录写相对路径，因此由 Host 共享投影层补全为绝对路径。

用户消息气泡中的缩略图只来自消息 `content` 里的 `image` / `localImage` 条目。Desktop 同时把附件清单（`# Files mentioned by the user:`）解析成文件标签；只有消息带图片条目时，才把对应图片从标签中移除。消息没有图片条目时，所贴图片只显示为文件名标签。

## Agent 消息：改写本地媒体路径

共享投影层对**所有外部 Harness** 的 `agentMessage` 生效，覆盖实时输出与历史重放，不修改 Adapter 交付的原始文本：

- 只处理单行显式 Markdown 图片（`![alt](目标)`）中的相对路径，不提升行内代码路径，普通链接保持原样。
- 唯一基准是 **Thread cwd**，不猜子目录、会话目录或工具命令中的 `cd`。如果图片实际基于另一个目录，可能找不到；若 Thread cwd 下恰有同名文件，也可能显示错图。此规则不保证解析所有原生工作目录下的相对路径。
- 解析出目的地后，在 resolve、文件检查及 percent 编码之前，跳过 POSIX 绝对路径、盘符、UNC、`file:` 及任何 URL，保持其原文。Grok/DSH Adapter 已改成绝对路径的目标不会再次编码。
- reasoning、工具输出、官方 Codex Thread 不进入这项改写。delegation 读取既有的已投影可见消息，因此也会读到改写后的 Markdown。

`@codexhost/harness-adapter/local-media-markdown` 的 `relativeImagesOnly` 模式提供上述窄范围；默认行为保持不变，供 Grok/DSH Adapter 处理额外目录与行内路径：

- 改写单行 Markdown 图片目标中的本地媒体路径，以及只包含一个媒体路径的单反引号单行代码（转成图片）。反引号代码跨度按等长反引号串闭合，多反引号或跨行代码跨度内的内容保持原样。普通链接保持原样；不搬移标点、不增删段落或周围空白。
- 顺序固定为：相对路径解析或 `fileURLToPath()` → `path.resolve()` → 校验最终目标的扩展名与文件是否存在 → 保护字面 `%` → Markdown destination 格式化。不是先检查原文里 `?` / `#` 前面的伪扩展名，再访问规范化后的另一个文件。
- 相对路径按 Adapter 给出的 `roots` 依次查找。**roots 是查找顺序，不是访问沙箱**：`..`、绝对路径与有效 `file:` URL 可以指向根目录外；文件检查会跟随符号链接。扩展名校验不等于文件内容类型校验，也不替代 Harness 自己的访问策略。
- 远程 URL、`data:` 等地址、找不到的文件和无法解析的写法保持原样。支持的扩展名：图片 `png`、`jpg`、`jpeg`、`gif`、`webp`、`svg`，音视频 `mp4`、`m4v`、`mov`、`webm`、`mp3`、`m4a`、`aac`、`ogg`、`wav`。
- Windows 盘符路径写成正斜杠（`C:/…`）。CommonMark 会把反斜杠加标点当作转义，原样输出会让 `C:\Users\me\.codex\…` 丢掉分隔符；UNC 路径保留并转义其反斜杠。

### 字面百分号与 Desktop 私有规则

Desktop 的 Markdown 图片 token 转换器和媒体加载组件各归一化一次本地路径。对真实绝对路径，每次使用 `decodeURI`；`file:` 输入的第一阶段则通过 URL pathname 解码。因此 Host 先把输入转成真实绝对路径，再把每个 `%` 写成 `%2525`。例如文件名中的字面 `%2F` 在两次解码后仍是 `%2F`，不是目录分隔符；Grok 以 `encodeURIComponent(cwd)` 命名的会话目录也遵循这条规则。

这只是字符串转换：不建立硬链接、不复制媒体，也不创建缓存目录。不能直接对原始 `file:` URL 做同样替换，否则 URL 中表示空格的 `%20` 也会被保护成字面文件名。带空格或括号的真实路径使用 `<…>` destination；中文、普通 `#` / `?` 字符保持原样。

规则依赖 Desktop 的两阶段加载链路，并不保证所有文件名可表达。Desktop 还会把 `#L12`、`#L12C3` 等结尾解释为行号引用；如 `a.png#L12` 这样的字面文件名不在本模块支持范围内。Desktop 版本变化后需重新检查归一化语义，而不是只运行两次自行假定的 `decodeURI`。

`tools/renderer-binding/media-path-probe.mjs` 可只读检查已运行 Renderer 中实际加载的图片 token 转换器与路径解析器。它按语义结构和 import/export 关系发现函数，不依赖压缩名称；缺失或不唯一时报 `unverified`。此检查不挂载图片、不读取文件，不能代替实机显示和远程文件传输验收。运行方式见 [`tools/renderer-binding/README.md`](../../tools/renderer-binding/README.md#local-media-path-contract)。

### 围栏与流式边界

支持的平面围栏：开头标记位于第 0 列且不带容器前缀，是三个或更多的同种反引号或 `~`；结束行最多缩进三个空格，使用同种字符，长度不短于开头，后面只允许空格、Tab 或 CRLF 留下的 `\r`。行中间的反引号串不算围栏。

本模块不重建 CommonMark 的容器嵌套。在引用块、无序/有序列表前缀后发现围栏，或发现任何缩进/Tab 后的围栏式标记时，从该标记到消息末尾都保持原样；即使后面还有普通媒体路径也不改写，以免错误判断容器结束后修改代码。这是保守支持范围，不是完整 CommonMark 解析器。

实时输出保持追加式，原始完成全文必须等于原始初始文本加所有增量。共享投影层为每个 Agent Item 创建独立的 `LocalMediaMarkdownStream`，不把显示文本写回原始账本；显示完成文本同样等于已发布的初始显示文本加增量。pending、terminal 和 final-answer phase replay 读取缓存显示文本，不重新检查文件；历史用同一 stream 消费全文并 flush。

共享投影层、Grok 与 DSH 均使用 `LocalMediaMarkdownStream`：只暂缓结尾未决的图片、代码跨度或可能增长的围栏标记，不等待整行、不等待后续标点。未闭合的反引号代码跨度可以跨行但不能跨空行（两个换行符之间仅有空白），暂缓到闭合、空行或 Item 结束；末尾的闭合反引号串也须等待后续字符确认长度。遇到空行或 Item 结束时将未匹配的反引号串作为普通文本处理，继续解析其后的图片，不扣住后续段落。同一条消息内缓存每个候选路径的存在性检查，包括未找到的结果，避免文件出现或根目录命中变化导致已发布文本需要撤回；新的消息使用新的缓存。文件变化后历史重载的显示结果可能不同。每次增量仍会重扫累计文本，超长回复与细粒度增量会增加 CPU 开销。

Grok/DSH 的额外目录仍由各自 Adapter 处理，优先于共享层：

| Harness | 根目录 | 范围 |
| --- | --- | --- |
| Grok | 工作目录、Grok 会话目录及其 `videos/`、`images/`、用户 `Downloads/` | 实时输出与历史 |
| DeepSeek Harness | 消息产生时 Agent 的工作目录（按事件顺序随 `working-directory/change` 更新，恢复未完成的 Turn 时也一样），再到 Session 工作目录 | 实时输出与历史（`readSnapshot`）；用量刷新不做改写 |

其他外部 Harness 不需要专属媒体接入代码，统一使用 Thread cwd 的相对图片规则。远程或容器文件系统与 Host 不一致时，不保证可用；SSH 媒体读取链及 Windows 实际文件系统行为仍需平台验证。

## 用户消息：还原图片附件

Desktop 发送带图片的消息时，请求里既有 `localImage` 条目，也在文字的附件清单中写下每张图片的绝对路径，并标注 `Image attachment: true`。公共 Harness 输入只有文字，Host 转发时只保留文字，Harness 按路径读取图片；Native Session 历史同样只有文字。

`protocol-core` 投影用户消息时，从文字中 `## My request:` 之前的附件清单读出这些路径，补回 `localImage` 条目，放在文字之后。开始 Turn、运行中插入和历史回放三处投影一致，因此新旧会话都显示缩略图，`imageCount` 也与 Desktop 的乐观消息一致。解析规则在 `@codexhost/shared-contracts` 的 `desktopImageAttachmentPaths`，Renderer 的远程附件补存使用同一规则。

边界：

- 只认附件清单中的绝对路径；用户在请求正文里写的路径不算附件。附件清单必须位于消息开头（前面只允许空行），遇到单独成行的 `## My request:` 时结束；纯图片消息没有该标题时，清单延伸到文本末尾。清单前有其他文字时不读取附件。
- 不读取、不复制图片。剪贴板截图通常保存在系统临时目录，文件被清理后缩略图无法加载。
- 远程外部会话的图片路径位于远程主机，其缩略图显示尚未单独验证。

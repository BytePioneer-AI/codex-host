# Pi Codex Fast

## 交互

Pi 当前 Model 支持 Fast 时，Composer 底部 Model 名称左侧紧凑排列独立的闪电按钮。灰色描边表示关闭，点击后与 Model 文字同色的实心闪电表示开启（深色主题下为白色），再点关闭；按钮复用 Host 自有样式，悬停显示浅色底和手形光标，不依赖 Codex 私有 DOM 或类名；支持键盘操作和 `aria-pressed`。鼠标移入或键盘聚焦立即显示 Host 自有浮层，复用用量面板的圆角、边框、阴影和明暗主题样式，不再使用有系统延迟的 `title`。浮层文案通过 `aria-describedby` 同时作为无障碍说明，不维护第二套提示文本；标题明确显示“Fast 已关闭 · 点击开启”或“Fast 已开启 · 点击关闭”，正文说明“Codex Fast 模式：优先处理请求，可能增加额度消耗。”浮层挂载到页面顶层，避免工具栏裁剪；移到浮层内可继续阅读，离开后短暂延迟关闭，按 Escape、点击外部或控件隐藏、禁用、卸载时关闭。点击不打开 Model 菜单，不改变 Thinking，也不增加 Model 菜单行或设置页。

新 Thread 默认关闭，包括恢复上一次新 Thread 的 Model/Thinking 偏好时。同一草稿按 Desktop 的草稿 ID 保留当前显式选择，Composer 重挂载不重新套用默认关闭，预建与发送使用该选择。Fork 的新 Pi 进程也默认关闭；Host 根据派生 Session 的实际 Model 引用更新持久化选择，重新打开时不意外继承来源 Thread 的 Fast。选择其他 Model 会关闭 Fast；切回支持的 Model 仍默认关闭。已存在 Thread 的显式选择通过现有 Model Ref 保存，恢复时只在原生当前 Model 相符且能力仍可确认时重新开启；能力不可用时恢复普通模式，不阻塞历史读取。

## 能力来源

Pi Adapter 在现有 `inspect()` 获取 Model 目录的同一临时 RPC 进程中检查 Host 扩展是否加载，再结合以下本地事实公布可用性：

- Pi `auth.json` 的 OAuth access token 声明被既有分类器识别为 Codex 凭据。按凭据来源判断，不按 Provider 名称；`c`、`codex-alice` 等别名也可支持。分类不验证 token 签名，不保证服务端授权。
- Pi 原生 Model 的 `api` 为 `openai-codex-responses`。
- `${CODEX_HOME:-~/.codex}/models_cache.json` 中对应 Model 的 `service_tiers` 明确包含 `priority`。
- 当前 Pi 提供完整 Provider 查询/注册接口，已加载的 Host 扩展公布可确认的设置命令。

缺少或未知事实时不显示按钮，不猜测模型支持，不主动下载模型元数据、请求账号接口或刷新凭据。能力随既有按 cwd 的 Model 目录缓存；显式刷新和凭据导入、重导入、移除沿用现有失效路径，不增加后台轮询。外部修改凭据或 Codex 元数据后需要刷新目录。已有会话的 cwd 尚未缓存时，选择 Fast 使用当前 Pi 进程查询模型与扩展能力，再做同样的本地判定，不另起 inspection 进程，也不借用其他 cwd 的能力结论。

## 请求与状态

小型扩展随 Pi Adapter Bundle 交付。启动原生 Pi 时，将内容寻址资源写到 `${CODEXHOST_DATA_DIR:-~/.codexhost}/extensions/pi-codex-fast/<digest>.mjs` 并通过 `--extension` 加载，不改 Pi 全局设置，也无需用户单独安装。默认关闭时不注册替代 Provider 或改变请求。

开启时扩展包装当前 Provider 已有的 `stream` / `streamSimple`，保留其认证、模型和其他原生方法，仅对启用的目标 Model 加入原生 `serviceTier: "priority"`。关闭时不添加该参数。各 Pi 进程独立持有开关；切换 Model 前关闭，切换 Thinking 保持开关。设置通过扩展命令执行，并等待带随机 nonce 的原生通知确认，不能把普通 Prompt 回执当作成功，也不重启 Pi 模拟 Fast。命令发送后发生错误或缺少确认时，将会话标记为故障并关闭原生进程，禁止继续发送；不能假定报错意味着请求策略未改变。运行中选择先完成 Thinking 能力查询，再切换 Fast 并立即公布已确认状态，避免后续查询失败留下未公布的 priority。

公共 Model Catalog 的可选 `fastModel` 是普通 Model 的独立、不含凭据的配置引用；Renderer、委派校验及 Model/Thinking 展示使用同一目录解析函数。Pi 的编码、凭据判定、缓存读取和请求语义全部属于 Pi Adapter，不进入 Host 或 Renderer。

## 验证边界

定向测试覆盖别名及导入凭据、非 Codex 凭据、API 与模型不支持、缺少元数据、并发资源发布、参数与 Thinking 保持、原生命令确认、确认失败后的进程关闭与发送阻断、选择及恢复、Fork 的持久化与重新打开一致性，以及浏览器中按钮显隐、开关、Model 菜单和键盘操作。

本机 Pi 的隔离离线冒烟检查确认扩展可加载，并能在显式加载的别名 Provider 上确认开关；使用合成凭据，没有发起 Model Turn。浏览器验证包含真实控件及 binding/prewarm 路由的隔离测试页面，覆盖同一草稿重挂载后预建与发送的 Fast 引用一致性，但不等同于完整 Codex Desktop 验收。尚未验证真实付费 priority 请求的服务端接受、速度或额度变化，也不保证任意用户扩展在之后重新注册 Provider 时仍保持该包装。

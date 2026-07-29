## Context

公开 DOM/preload 接口无法把独立 Agent 选择稳定绑定到具体 `thread/start`。受支持 Codex Desktop build 的创建参数由 React 私有 Model 状态生成，自动标题则通过主进程 AppHost metadata service 创建独立 ephemeral Thread。Host 已支持 `codexhost/pi-native` transport token、Pi 文本投影和首 Turn 延迟启动。

## Goals / Non-Goals

**Goals:**

- 当前白名单 Desktop build 中，把首次输入前锁定的 Composer Agent 写入原生 conversation 创建状态。
- Pi 使用内部 transport token，Codex 创建保持官方 Model 状态。
- Pi 标题不把用户输入发送到 Codex ephemeral Thread。
- 结构、版本、Composer identity 或窗口归属不明确时 fail closed。
- Host 用脱敏 ordinal 证明最终 Turn 消费的创建请求和 Native Session。
- 同一 Pi Thread 后续 Turn 复用 Native Session。

**Non-Goals:**

- 不支持输入后切换 Agent、任意 Desktop 版本或修改 ASAR。
- 不实现 Mapping Store、完整 Tool/Question/Cancel/Fork 或正式发布兼容矩阵。
- 不读取、检查、记录或序列化 Prompt、Transcript、完整 DOM、完整 Model ID、完整请求 ID 或完整 Thread ID。
- 不解析或替换 Cap'n Web 原始字符串。

## Decisions

### 1. 首次输入前锁定 Composer Agent

Renderer 在当前 Composer 的首次有效 `beforeinput` 捕获阶段锁定 Agent。锁定后禁用 Agent 控件；切换 Harness 必须新建 Thread。

Composer replacement 使用 React Model target 的不透明对象身份判定：

```text
同一target引用                → transfer
locked default → conversation → 首次创建，transfer
conversation → default        → 新任务，不transfer
不同conversation target       → 不transfer
target不唯一或不可用           → fail closed，不transfer
```

source target 在 mount 时捕获为不透明引用，replacement 判定在 mutation 后的 scan 执行。新 Composer mount 后，由 Probe 按该 Composer 自己的 Registry 状态应用 Adapter；Adapter 不保存进程级“下一 Agent”。

### 2. 直接更新 optimistic Model atom

版本 Adapter 按 asset 白名单和结构签名，从当前 Composer Fiber 的 React Compiler memo cache 中唯一归并：

```text
optimistic Model atom
committed Model atom
opaque Model target
```

Pi 直接同步写入：

```text
{ model: "codexhost/pi-native", reasoningEffort: 当前值 }
```

Codex 恢复捕获前的不透明 optimistic atom snapshot。Adapter 不调用会去抖和持久化用户默认 Model 的官方 setter，也不包装已证伪的 request client/manager 方法。

Adapter 只比较 transport token，不检查或记录官方 Model ID。atom、target、reasoning state 或 Composer 关联不唯一时 Pi unavailable；输入和提交事件被阻止，不能回落 Codex。

### 3. Pi 自动标题使用本地 fallback

Codex Desktop 的自动标题服务会把输入发送到独立 official ephemeral Thread。主进程标题策略通过 Inspector 结构化定位：

```text
connect-app-host listener
→ getContextForWebContents
→ WindowContext.createAppHost(webContents)
→ ThreadMetadataGenerationService.generateTitle
```

`createAppHost` 为 metadata service 绑定所属 `webContents`。`generateTitle` 调用时查询该窗口 Probe 的唯一 locked Agent：

- locked Codex 调用原始标题服务；
- locked Pi 返回 `null`，触发 Desktop 已有本地 fallback；
- 缺少 owner、Probe 或唯一 locked Agent 时返回 `null`，fail closed。

策略不读取 `generateTitle` 的 Prompt 参数。安装后 Renderer reload 一次，使活动 AppHost service 获得直接窗口归属；Desktop Control确认 ownership 后显式写入窗口 readiness 标记。Renderer Adapter缺少该标记时保持unsupported。

### 4. Pi Session 延迟到首个 Turn

Host 在 Pi `thread/start` 时建立 Thread 归属和 `LazyPiSession`，但不启动 `PiRpcSession`。对应 `turn/start.threadId` 首次到达时才创建并启动 Session。同一 Thread 后续 Turn 复用 Session；未消费预热 Thread 没有 Pi 子进程。

### 5. Host 使用匿名 create ordinal

Host observer 为每个 `thread/start` 分配递增 `createOrdinal`，在 official/Pi 创建响应时只在进程内绑定真实 Thread ID。`turn/start` 输出 matched/unmatched ordinal、Harness 和 `conversation | ephemeral` purpose。

观察数据不含 Prompt、Model 值、请求 ID 或 Thread ID。来源判断以 carrier、ordinal 关联和进程证据为准，不以回复文本判断。

### 6. transport-only Gate 先于真实 Pi

受控 Gate 必须先证明：

```text
Codex conversation create → official-model
Pi conversation create    → pi-transport
Pi title generation       → 本地fallback，无official ephemeral create
```

之后才能验证首个 Pi Turn 启动一个 Native Session、输出进入同一 Thread，以及后续 Turn 不创建 Thread并复用同一 Session。

## Risks / Trade-offs

- [私有结构随 Desktop 升级变化] → asset 白名单、Fiber/AppHost 双结构签名和 fail closed；新版本重新验收。
- [Adapter 晚于首次输入] → Pi 在 Adapter ready 前禁用；安装失败保持明确 unavailable。
- [新 Thread 与 DOM replacement 混淆] → 不透明 Model target identity 和仅允许 locked `default → conversation` 转移。
- [标题调用窗口归属不明确] → 不调用 official title service，使用本地 fallback。
- [多个预热 Thread] → Host 只记录归属，Native Session 延迟到 matched 首 Turn。
- [Inspector 生命周期] → 标题策略在 Probe 前安装并触发一次 Renderer reload；策略缺失时 Pi 不应进入可提交状态。

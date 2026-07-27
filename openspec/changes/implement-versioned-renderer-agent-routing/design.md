## Context

Windows Codex Desktop `26.721.4979.0`的独立Agent UI和Composer状态已验证，但选择Pi后产生的三个真实`thread/start`仍使用官方Model。当前Renderer没有公开Model setter；旧调查证明可写的private prewarm seam能够影响真实创建Request，但存在版本、安装竞态和共享Request污染风险。Host已经支持`codexhost/pi-native`并能把Pi文本投影回Codex UI。

## Goals / Non-Goals

**Goals:**

- 当前已验证Desktop build中，把首次输入前锁定的Composer Agent写入同一次`thread/start`。
- Pi使用内部transport token，Codex请求保持透明。
- 结构或版本不匹配时fail closed，不静默进入Codex。
- 多个预热创建只让最终收到`turn/start`的Pi Thread启动Native Session。

**Non-Goals:**

- 不支持输入后切换Agent、任意Desktop版本或修改ASAR。
- 不实现Mapping Store、完整Tool/Question/Cancel/Fork或正式发布兼容矩阵。
- 不读取或记录Prompt、Transcript、完整DOM、Model原值或完整请求ID。

## Decisions

### 1. 首次输入前锁定Composer Agent

Renderer在当前Composer的首次`beforeinput`捕获阶段锁定Agent，先于React触发预热。锁定后禁用Agent控件；新建Thread产生新的默认Codex状态。已有文本、多个候选Composer或状态不明确时禁止Pi。

### 2. 版本Adapter装饰创建参数

Adapter按Desktop build和运行时结构签名定位活动创建边界，并在该边界克隆参数。Pi克隆只把`model`替换为`codexhost/pi-native`；Codex调用原方法和原参数。Adapter不包装其他Method，不使用`params.codexhost`，也不通过未来请求顺序消费选择。

当前调查已证明动态导入asset会得到第二模块实例，`electronBridge`被contextBridge冻结，普通`codex_desktop:message-from-view` IPC也不承载app-server创建请求。活动请求实际经过`connect-app-host`建立的MessagePort Cap'n Web RPC。该结构化入口尚未唯一定位，因此当前Adapter必须报告`unsupported`并禁用Pi；不能把已安装但未命中活动请求的Hook标记为ready。

### 3. 请求时同步读取唯一锁定Composer

Adapter调用发生时必须能确定唯一锁定的新Thread Composer；Agent选择直接参与当前方法调用，不经过跨进程pending intent。多个或零个Pi候选、Adapter晚安装、Renderer重载或结构签名变化都使Pi不可用。

### 4. Pi Session延迟到首个Turn启动

Host在Pi `thread/start`时分配Host Thread ID并记录Pi归属，但不启动`PiRpcSession`。对应`turn/start.threadId`首次到达时才创建并启动Session，然后执行Turn。同一Thread后续Turn复用该Session；未被消费的预热Thread没有Pi子进程，Host关闭时清理内存归属。

### 5. transport-only Gate先于真实Pi

受控验证先让Host只分类路由，证明Codex创建均为`official-model`、Pi创建均为`pi-transport`，并覆盖一次输入/发送产生的全部`thread/start`。通过后才启用真实Pi并确认最终`turn/start`只启动一个Native Session。

## Risks / Trade-offs

- [私有结构随Desktop升级变化] → build白名单、结构签名、安装确认和fail-closed；每个新版本重新验证。
- [Adapter晚于首个输入安装] → Pi控件在Adapter ready前禁用；安装失败保持明确不可用。
- [输入后切换与预热不一致] → 首次`beforeinput`锁定Agent，切换必须新建Thread。
- [多个预热Thread] → Host只记录归属，Native Session延迟到首个Turn。
- [无法取得活动MessagePort RPC中的结构化克隆seam] → 保持Pi unsupported并记录BLOCKED，不解析或字符串替换可能包含Prompt的原始RPC消息，也不原地污染共享Request。

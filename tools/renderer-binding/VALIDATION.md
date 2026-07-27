# Codex Renderer Agent 绑定验证记录

## 结论

截至 2026-07-27，在 Windows Codex Desktop `26.721.4979.0` 上得到以下真实结论：

- Electron 主进程 Inspector可以在真实 Codex Renderer中注入独立的`Codex / Pi` Agent选择器；
- Agent选择可以按 Composer保存，并能在提交时正确捕获`agent: "pi"`；
- Host Runtime可以把`thread/start.params.model == "codexhost/pi-native"`解码为 Pi transport route；
- 独立Agent选择器不会更新Codex原生Model状态，也不会使真实`thread/start.params.model`变为`codexhost/pi-native`；
- 分阶段验证中，选择Pi后出现的三个真实`thread/start`全部仍携带官方Model，Host因而选择Codex，实际回复也来自Codex；
- 当前Codex Renderer的公开DOM和preload API没有提供设置原生Model或装饰具体创建请求的稳定入口，标准`thread/start`参数中也未发现可与DOM Composer identity直接对应的字段。

验证状态：

```text
独立 Agent UI 注入与提交选择捕获：PASS
Pi transport Model ID 的 Host 路由：PASS
独立 Agent 选择 -> 具体 thread/start.model：BLOCKED
页面选择 Pi -> 真实 Pi Native Session：未实现
```

该`BLOCKED`是当前Codex Desktop的实际接口边界，不是codexhost的产品设计偏好。不得把Renderer本地捕获到`agent: "pi"`声明为Pi路由成功，也不得在绑定失败时静默进入Codex。

## 验证环境

| 项目 | 值 |
| --- | --- |
| 操作系统 | Windows `10.0.26200 x64` |
| Codex Desktop | `26.721.4979.0` |
| Codex CLI | `0.146.0-alpha.3.1` |
| Chromium CDP | Chrome `150.0.7871.128`，Protocol `1.3` |
| Host默认Agent | `codex` |
| Pi route token | `codexhost/pi-native` |

验证只记录Method、字段分类、元素数量、属性名、生成的Probe ID和Agent选择。未读取或保存Prompt、输入内容、Transcript、完整DOM、Model原值或完整请求ID。

## Renderer 注入事实

生产窗口的`webPreferences.devTools`处于关闭状态。`--remote-debugging-port`只暴露一个外层`app://-/index.html` page，其DOM约25至31个节点，不包含真实Composer。

Electron主进程Inspector仍可通过公开的`webContents.getAllWebContents()`找到已填充的主Renderer，并使用`webContents.executeJavaScript()`注入browser-safe Renderer bundle。注入后确认：

- `Codex / Pi`控件可以挂载在原生Model控件与发送按钮之间；
- 当前Composer可通过`data-codex-composer-root`定位；
- 选择Pi后，提交观察记录为`agent: "pi"`；
- 一次点击提交期间发生两次无歧义的Composer DOM替换，选择状态通过同一逻辑Composer状态传递，最终仍为Pi。

这证明独立Agent UI和Renderer本地提交意图捕获可行，但不证明创建请求已经携带该选择。

## 创建时序事实

通过codexhost Shim启动真实Desktop，Host默认Agent固定为Codex，并在Host创建边界仅记录脱敏路由分类。人工操作被拆成独立阶段：

| 阶段 | 累计`thread/start` | 新请求Model分类 |
| --- | ---: | --- |
| Renderer加载完成 | 0 | 无 |
| 点击“新建任务” | 0 | 无 |
| 选择Pi | 0 | 无 |
| 开始输入但不提交 | 1 | `official-model` |
| 点击发送 | 3 | 新增两个`official-model` |

Renderer在最后一次提交时记录：

```json
{
  "agent": "pi",
  "trigger": "click",
  "replacementTransfers": 2
}
```

Host对三个创建请求的分类均等价于：

```json
{
  "requestMethod": "thread/start",
  "modelCarrier": "official-model",
  "selectedHarness": "codex",
  "selectionSource": "official-model"
}
```

该时序排除了两个假设：

1. 不是因为`thread/start`在选择Pi之前已经发生；三个请求均发生在选择Pi之后。
2. 不是因为Composer替换导致Pi选择丢失；提交时Renderer仍捕获到Pi。

缺失行为被精确定位为：独立Agent状态没有进入Codex原生Model状态或创建请求构造器。

## 当前 Codex 公开接口边界

对当前安装包进行只读检查后确认：

- 原生Model Picker通过React拥有的`onModelChange`回调更新状态；
- DOM没有可用于设置Model的语义化`data-app-action`；
- preload暴露的`electronBridge`没有公开“设置Model”或“按给定Model创建Thread”的方法；
- 当前标准`thread/start`参数结构包含Model、cwd、权限、sandbox等创建参数，但未发现与DOM Composer identity直接对应的字段；
- Renderer内部存在Composer和client thread状态，不等于这些状态通过公开边界对codexhost可用。

所以，纯DOM控件与公开preload API不足以把独立Agent选择原子写入某个具体`thread/start`。使用进程级/窗口级`nextHarness`、时间窗口或“下一条创建请求”顺序猜测虽然可以制造单用户演示，但不能满足并发安全和失败安全要求。

## 与已有能力的关系

当前已有两项独立能力：

```text
A. Renderer独立Agent选择器
   -> Composer状态
   -> 提交时捕获agent: pi

B. thread/start.model == codexhost/pi-native
   -> Host decodeCreateRoute
   -> PiAdapter
   -> Pi Native Session
```

本次验证证明A与B之间没有现成的公开连接。现有真实Pi文本闭环使用Launcher级`--agent pi`完成，不是页面按钮修改了Model ID。

`codexhost/pi-native`仍可作为内部协议路由令牌，但它不表示Pi是领域Model，也不能仅因Host支持该令牌就声称页面Agent绑定已完成。

## 后续约束

在当前版本上继续实现，需要明确选择以下方向之一：

1. 保持public-only边界：页面请求级绑定继续标记`BLOCKED`，等待Codex提供稳定扩展点或发现新的公开关联字段。
2. 采用严格版本锁定的最小私有请求Hook：必须单独评审安装竞态、Composer切换、预热复用、请求污染和升级失效风险；结构不匹配时必须fail closed。
3. 设计新的并发安全创建协议：只有在Renderer intent和创建请求拥有共同稳定键时才可使用sidechannel，不得退化为全局临时Agent或按到达顺序消费。

无论采用哪条路径，验收都必须看到同一次创建的完整证据：

```text
Renderer选择Pi
-> 对应创建请求携带可验证的Pi route
-> Host selectedHarness == pi
-> 创建真实Pi Native Session
-> Pi输出进入同一Codex Thread
```

## 证据位置

- Renderer Probe：`packages/renderer-extension/src/renderer-binding-probe.ts`
- Composer状态：`packages/renderer-extension/src/agent-selection-state.ts`
- CDP/Inspector控制：`packages/desktop-control/src/cdp-client.ts`
- Host路由分类：`packages/host-runtime/src/app-server-host.ts`
- 受控运行器：`tools/renderer-binding/run.mjs`
- 测试Host入口：`tools/renderer-binding/observed-host.mjs`

脱敏本地证据保存在Git忽略目录`.codexhost/renderer-binding/`，包括Renderer状态报告、Host route分类和分阶段时序报告。这些本地文件不作为可提交产品数据。

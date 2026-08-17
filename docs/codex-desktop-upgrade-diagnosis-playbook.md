# Codex Desktop 更新兼容性诊断手册

本文总结 codexhost 遇到 Codex Desktop 更新后功能异常时的排查方法。目标是尽快回答两个问题：

1. 是 Renderer 注入入口失效，还是注入已经成功但后续业务链路失败？
2. 用户看到的 `Agent` / `Model` 不可用，实际对应哪一个请求、哪一个状态转换或哪一个 Codex 私有 API？

本文基于 Codex Desktop `26.814.41407` 事故整理，后续 Codex 更新时应优先复用这套流程。

相关兼容性债务记录见：

- `docs/codex-desktop-26.814-compatibility-debt.md`

## 一、先建立分层模型

不要把“注入失败”“Harness 不可用”和“Agent 切换失败”当成同一个问题。至少分为以下几层：

```text
Codex Desktop 启动
    -> Main-process title policy
    -> Renderer bundle 注入
    -> Draft prewarm / Request Bridge 注入
    -> Renderer Adapter ready
    -> Agent 菜单状态
    -> Agent 切换动作
    -> prewarm 清理
    -> Model / Harness inspection
    -> Model 菜单渲染
```

每一层都有不同的成功信号：

| 层 | 成功信号 | 不能证明什么 |
| --- | --- | --- |
| Title policy | 标题服务结构检查和 Renderer readiness 均成功 | 不能证明 Renderer 注入成功 |
| Renderer bundle | `window.__codexhostRendererBindingProbeV1` 存在 | 不能证明 Request Bridge 可用 |
| Draft routing | Adapter 为 `ready / request-bridge` | 不能证明 Agent 点击流程完整可用 |
| Harness availability | inspection 返回 `status: ready` | 不能证明 Agent 切换清理成功 |
| Agent 切换 | probe 的 selection agent 发生变化 | 不能证明 Model catalog 已加载 |
| Model catalog | Model 按钮有真实模型名且未 disabled | 不能证明发送 Turn 时 Model 路由正确 |

**重要：Adapter `ready` 不是最终验收标准。** 本次事故中 Adapter 已经是 `ready`，但 Agent 点击仍被旧的 prewarm 清理 RPC 中断。

## 二、第一步：记录现场版本和启动方式

先记录 Codex Desktop 和 Codex Framework 的真实版本，不要只记录项目版本：

```bash
ps -axo pid,ppid,command | rg -i 'ChatGPT.app|--inspect='
```

同时确认启动使用的是当前工作区产物：

```bash
ps -axo pid,ppid,command | rg -i 'codexhost launch|host-runtime|desktop-controller|renderer'
```

重点确认：

- Codex Desktop 版本
- Codex Framework 版本
- Renderer bundle 路径是否指向当前工作区
- Host Runtime 和 Desktop Controller 是否来自当前工作区
- 是否通过 `npm start` 重新构建过

不要假设 Inspector 固定在某个端口。`npm start` 会为每次启动分配新的临时 Inspector 端口。

可以从运行进程动态提取端口：

```js
const { execFileSync } = require("node:child_process");
const processes = execFileSync("ps", ["-axo", "command="], { encoding: "utf8" });
const match = processes.match(
  /ChatGPT\.app\/Contents\/MacOS\/ChatGPT --inspect=127\.0\.0\.1:(\d+)/,
);
const inspectorEndpoint = `http://127.0.0.1:${match[1]}`;
```

## 三、第二步：建立最小的真实反馈闭环

排查前先建立一个能复现用户具体症状的闭环。不要只运行单元测试或只读取 Adapter status。

本次事故最有效的闭环是：

```text
启动 npm start
    -> 找到 app://-/index.html 主窗口
    -> 读取 Renderer binding status
    -> 点击一个外部 Agent
    -> 读取 selection
    -> 读取 Model 按钮的 text、aria-label、title、disabled
```

验收至少包含：

- Agent selection 是否改变
- Model 按钮是否仍为 `Models unavailable`
- Model 按钮是否 disabled
- `title` 是否包含真实错误文本
- Adapter 是否在操作前后发生异常状态转换

本次真正的根因直接出现在 Model 按钮的 `title` 中：

```text
Invalid request: unknown variant `clear-prewarmed-threads-for-host`
```

这比只看 `availability: error` 有用得多。

### 推荐的 DOM 现场信息

读取与 Agent 和 Model 相关的按钮：

```js
[...document.querySelectorAll("button")]
  .map((button) => ({
    text: (button.innerText || "").trim(),
    aria: button.getAttribute("aria-label"),
    title: button.getAttribute("title"),
    checked: button.getAttribute("aria-checked"),
    disabled: button.disabled,
  }))
  .filter((item) => /agent|model|pi|claude|deepseek|grok/i.test(
    [item.text, item.aria, item.title].join(" "),
  ));
```

## 四、第三步：确认是否真的注入成功

### 1. 找主 Renderer，而不是 overlay

Electron 可能同时有多个 `webContents`。`avatar-overlay` 等窗口不一定有 Composer，也不应该作为主 Renderer 验证目标。

在 Node Inspector 中读取：

```js
webContents.getAllWebContents().map((contents) => ({
  id: contents.id,
  type: contents.getType(),
  url: contents.getURL(),
  title: contents.getTitle(),
}));
```

优先选择：

```text
type === "window"
url === "app://-/index.html"
```

### 2. 读取 codexhost binding

```js
window.__codexhostRendererBindingProbeV1?.status?.()
```

重点记录：

```json
{
  "availability": {
    "pi": "ready",
    "claude-code": "ready"
  },
  "selections": [
    {
      "agent": "pi",
      "phase": "draft"
    }
  ],
  "adapter": {
    "state": "ready",
    "reason": "ready",
    "hook": "request-bridge"
  }
}
```

判断规则：

- binding 不存在：先排查 Renderer bundle 执行失败、标题策略阻断或注入时机。
- Adapter 不是 `ready`：先排查 Request Bridge 和 draft routing。
- Adapter 已 `ready`：不要再把问题笼统称为“注入失败”，继续验证 Agent 点击链路。

## 五、第四步：探查当前 Composer Fiber 和 Request Bridge

Codex 更新后，不能默认旧的函数名和闭包变量仍存在。应从当前 Composer 的 React Fiber 读取实际对象。

需要记录以下信息：

- Composer 是否存在
- React Fiber 是否存在
- Fiber 中请求对象的数量和对象身份
- outer manager 与 inner request client 的关系
- `hostId`
- `sendRequest`
- `prewarmThreadStart`
- `enqueueRequest`
- `prewarmedThreadManager`
- 是否存在 codexhost policy

当前 Codex 的实际结构是：

```text
outer manager
  - requestClient -> inner bridge
  - hostId: "local"
  - prewarmedThreadManager
  - sendRequest: 委托函数

inner bridge
  - hostId: "local"
  - sendRequest
  - prewarmThreadStart
  - enqueueRequest: 原型方法
```

注意两点：

1. `enqueueRequest` 可能在原型上，不一定出现在 `Object.keys()` 中。
2. policy 替换 `sendRequest` 后，函数源码会改变。不能再用函数源码作为唯一身份判断。

### 识别策略

优先使用稳定 API 形状：

```text
hostId === "local"
has sendRequest
has prewarmThreadStart
has enqueueRequest
```

旧版 `Function.prototype.toString()` 特征只能作为兼容 fallback，不能作为当前版本的主路径。

## 六、第五步：沿用户点击路径逐步验证

点击外部 Agent 后，不要只看最终 UI。按以下顺序检查：

```text
1. Agent 菜单项是否存在且没有 disabled
2. click 后 selection agent 是否改变
3. draft prewarm policy.clear() 是否成功
4. policy.select(model) 是否成功
5. Harness inspection RPC 是否发送
6. inspection 是否返回 ready
7. Model catalog 是否写入 DOM
```

### 优先检查清理动作

Agent 切换通常先清理旧的 prewarm Thread。当前版本应检查：

```text
prewarmedThreadManager.discardAllPrewarmedThreads()
```

如果看到以下错误，说明仍然走了旧版路径：

```text
unknown variant `clear-prewarmed-threads-for-host`
```

不要先增加 availability 重试。先修复切换流程中失败的请求。

### 检查真实 Harness inspection

如果 UI 显示 `Models unavailable`，需要区分两种情况：

#### 情况 A：Harness 本身不可用

直接通过真实 Renderer 的 Request Bridge 发送：

```text
codexhost/harness/inspect
```

分别测试：

```text
pi
claude-code
deepseek-harness
grok
```

如果 RPC 返回 `status: ready`，说明 Harness、账号和网络不是根因。

#### 情况 B：Request Bridge 查找失败

如果直接调用真实 bridge 可以成功，但 Renderer Model client 失败，重点检查：

- `findActivePrewarmTargets()` 是否返回 0 个对象
- policy 包装后函数源码是否改变了查找结果
- Model client 是否每次调用重新查找 target
- 注入的对象是否仍是当前 Fiber 中的同一个对象

## 七、常见误判

### 误判 1：Adapter ready 就代表全部修复

错误。Adapter ready 只代表 routing policy 已安装。Agent 切换中的 prewarm 清理、Model inspection 和 DOM 渲染仍可能失败。

### 误判 2：availability error 就一定是 Harness 命令或账号问题

错误。availability 状态可能吞掉了真实异常。必须读取真实 RPC 错误或 Model 按钮的 `title`。

### 误判 3：四个 Harness 同时 error 就一定是网络问题

如果所有 Harness 同时失败，优先怀疑共享链路：

- Request Bridge 无法发现
- Host Runtime RPC 不通
- Adapter 正在切换
- Renderer model client 使用了过时的对象识别逻辑

不要一开始分别排查四个 CLI。

### 误判 4：固定 Inspector 端口

`npm start` 使用临时端口。每次重启都应重新发现端口。

### 误判 5：只依赖单元测试

旧的 mock 可能仍然接受已被 Codex 删除的 RPC。必须补充真实版本的 Renderer smoke test，至少验证一次完整 Agent 点击路径。

### 误判 6：看到新字符串就直接加入白名单

标题服务 identity 变化时，应先确认：

- 服务结构仍然符合预期
- 所有权判断仍然正确
- 标题隔离仍然只作用于 codexhost 自己的 Renderer

确认结构后才加入审查列表。

## 八、修复原则

### 1. 稳定 API 形状优先于函数源码

函数名、压缩变量名、函数源码和闭包变量都属于高风险私有实现。只有在没有稳定 API 形状时，才使用源码特征作为版本 fallback。

### 2. 每个 fallback 都要标记删除条件

旧代码不应该无期限存在。每个 fallback 至少要记录：

- 服务哪个 Codex 版本
- 当前版本是否还会进入
- 删除需要满足的最低支持版本
- 对应测试文件

### 3. 共享链路优先做单点验证

多个 Agent 同时失败时，先测试共享的 Request Bridge 和 Host RPC，再排查具体 Harness。

### 4. 以用户操作为主线做验证

最终回归应该模拟用户真正的操作，而不是只检查内部状态：

```text
点击 Agent
-> 等待切换
-> 读取 selection
-> 打开 Model 菜单
-> 读取 Model catalog
```

## 九、推荐的修复后验收清单

每次 Codex 更新后的兼容性修复至少完成以下检查：

- [ ] 记录 Codex Desktop 和 Framework 版本
- [ ] 动态发现当前 Inspector 端口
- [ ] 选择正确的 `app://-/index.html` 主 Renderer
- [ ] 标题策略无未解释的 warning
- [ ] binding probe 存在
- [ ] Adapter 为 `ready / request-bridge`
- [ ] Fiber 中 active request target 数量为 1
- [ ] policy 包装后仍能找到 active request target
- [ ] 当前版本的 prewarm 清理 API 可用
- [ ] 点击 Pi 后 Model catalog 可加载
- [ ] 点击 Claude Code 后 Model catalog 可加载
- [ ] 点击 DeepSeek Harness 后 Model catalog 可加载
- [ ] 点击 Grok 后 Model catalog 可加载
- [ ] 切回 Codex 后原生 Composer 仍可用
- [ ] 新 Thread 和未锁定 Thread 都完成切换验证
- [ ] 已锁定 Thread 仍按设计保持 locked
- [ ] 真实错误不会只被转换为笼统的 `Models unavailable`
- [ ] 聚焦测试、TypeScript、Prettier 和 `git diff --check` 通过

## 十、本次事故的最短定位路径

这次问题如果重新发生，建议直接执行：

```text
1. npm start
2. 读取动态 Inspector 端口
3. 读取 app://-/index.html 的 binding status
4. 点击一个外部 Agent
5. 读取 Model 按钮 title
6. 若出现 unknown variant，检查 prewarm 清理 API
7. 若没有具体错误，检查 findActivePrewarmTargets 数量
8. 直接调用 codexhost/harness/inspect 区分 Harness 问题和共享 Bridge 问题
9. 修复后重新点击 Agent 并验证真实 Model 文本
```

本次事故的关键错误不是：

```text
Harness 不可用
```

而是：

```text
Agent 切换前仍调用了当前 Codex 已删除的旧版 prewarm 清理 RPC
```

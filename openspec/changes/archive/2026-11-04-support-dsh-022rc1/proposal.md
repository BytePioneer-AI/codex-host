## Why

DSH `0.2.2-rc.1`（npm `next`）仍写 Session Format V4，但重构了 Session Remote：`session/control` 的投影帧改为一个事件一帧、列出全部变化的键，`session/page` 回显截止点，普通 Fork 的子会话不再记录来源，`session/follow` 不再默认恢复冷 Agent，模型目录与提问分别新增 badge 与授权 intent。Adapter 对这些返回值按精确形状校验，因此在 `0.2.2-rc.1` 上连新建会话都会以 `protocolError` 失败。`0.2.1-rc.3` 至 `rc.5`（rc.5 现为 npm `latest`）无需改动，但尚未列入已验证版本。

## What Changes

- control 流同时接受单键帧与多键帧，多键帧逐键沿用原有的过期、同序号与冲突规则。
- 分页接受回显截止点的页面，截止点必须与请求一致。
- follow 请求显式要求恢复 Agent。
- Fork 接纳没有来源字段的子会话，仍逐条比对继承前缀。
- 模型 badge 校验后丢弃；授权提问按 DSH 的约束接受，投影为不允许自由输入的选择题。
- 将 `0.2.1-rc.3`、`rc.4`、`rc.5` 与 `0.2.2-rc.1` 列入已验证版本，同步低版本提示、插件 notice、连接页与文档。

## Decisions

- 不按版本分支：新旧形状都按精确形状接受。follow 的 `activate` 对旧版本同样发送，旧版本的参数解析丢弃未声明字段，`0.1.7-rc.1` 与 `0.2.0-rc.2` 实测接受。
- 保留 `activate`：真实 CLI 的崩溃恢复与冷恢复探测中没有观察到差别，但它让 `0.2.2` 打开会话的行为与已验证的旧版本一致，也是 DSH 升级指南的要求。
- badge 只是显示数据，codexhost 的模型目录没有对应位置；保留原模型标签，不拼接 badge 文本。
- 升级命令继续跟随 npm `latest`，不因验证了 `next` 上的版本而改变。

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `deepseek-versioned-web-protocol`: 已验证版本加入四个版本；control 流、分页、follow、Fork、模型目录与授权提问接受 `0.2.2-rc.1` 的形状。
- `deepseek-harness-fast-session`: 不再重复列出已验证版本，改为引用 `deepseek-versioned-web-protocol`，避免两处列表不同步。

## Impact

- `packages/adapters/deepseek-harness`：`modern/control-store.ts`、`journal.ts`、`deepseek-harness-adapter.ts`、`catalog.ts`、`event-gateway.ts`、`session.ts`、`generation-selector.ts`、`manifest.json` 及测试。
- `packages/renderer-extension`：连接页支持版本文案（中英）。
- 文档：`docs/harnesses/deepseek/` 与 `docs/architecture/` 中提及已验证版本的文档。
- 不改 Host、`shared-contracts` 或公共插件契约。

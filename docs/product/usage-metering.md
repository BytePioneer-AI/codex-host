# 会话用量计量

外部 Harness 会话的用量浮窗中，费用、平均缓存命中、首 token（TTFT）和输出速度（TPS）由 Host 统一计算，不同 Harness 之间可以直接比较。规范见 `openspec/changes/add-host-usage-metering/`。

## 显示的指标

| 指标 | 含义 | 来源 |
| --- | --- | --- |
| 会话费用估算 | 本会话全部请求的 Token 按公开 API 价格折算的金额 | Host 按请求记录与价格表计算 |
| 平均缓存命中 | 累计缓存读取 ÷ 累计输入 | Host 按请求记录计算 |
| 最近缓存命中（CH） | 最近一次请求的缓存命中率 | Adapter 原生上报（不变） |
| 输出速度 | 当前（或最近）一轮至今的平均产出速度：Σ 输出 Token（含思考）÷ Σ 各请求生成时长（从首个思考、正文或工具调用 Token 到请求结束，不含预填充和工具执行，与 DeepSeek dsh 口径一致），每完成一次请求更新 | Host 按请求计时计算 |
| 首 token（TTFT） | 最近一轮从开始到首个推理或正文输出的时间 | Host 观测，所有 Harness 都有 |

Token 累计、上下文、套餐等字段仍由 Adapter 原生上报，Host 不覆盖。

输入框下方的用量按钮显示“最近缓存命中（CH）· 输出速度 · 费用”，例如 `CH 99.6% · 232 tok/s · $12.23`。按钮用最近值：所有 Harness 都有，并能及时反映缓存失效；平均缓存命中只在浮窗中显示。速度 100 以上取整；费用 1 美元以上保留两位小数，以下保留三位。缓存写入为 0 或未知时，浮窗只显示缓存读取。

## 已接入的 Harness

Pi、OMP、OpenCode v2、Claude Code、DeepSeek Harness（dsh）、CodeBuddy、WorkBuddy。其余 Harness 继续显示原生费用，后续分批接入；OpenCode v1 不接入。

接入的 Adapter 在每次打开会话时回放原生历史中的全部请求，再声明历史是否完整；运行中每完成一次模型请求发布一条请求记录。Host 只在内存中计量，不持久化，重启后重新回放即可得到相同结果。

## 什么时候不显示

宁可不显示，也不显示错的数字。以下任一情况会省略整个会话的费用：

- 某次请求的模型或缓存数据未知；
- 原生历史读取失败或不完整，或运行中某次请求的用量缺失；
- 会话中没有任何一次请求能计价。

某些请求的模型在价格表中查不到（如 `auto`、`gpt-5.3-codex-spark`），或缺少需要的缓存单价时，这些请求不计入，费用显示为下限，例如 `≥$12.23`，浮窗中注明“未计价：模型 ID”。在 `pricing.json` 中补上价格后即恢复完整费用。

缓存数据未知或历史不完整时，平均缓存命中也不显示。首 token 与输出速度只依赖本次观测，不受影响。

## 计费口径

- 每次请求按它实际使用的模型单价计算，会话中途换模型也能算对。
- 费用 = 未命中输入 × 输入单价 + 缓存读 × 缓存读单价 + 缓存写 × 缓存写单价 + 输出（含思考）× 输出单价。
- 缓存写入分两档：默认（5 分钟）按价格表的缓存写入单价；1 小时档按输入单价 × 2，与 Claude Code 内置价格一致（models.dev 只提供 5 分钟档），可在 `pricing.json` 用 `cacheWrite1h` 覆盖。
- Claude Code：费用与其 `costUSD` 的差额来自它在流与转录之外发出的后台请求；不计网页搜索按次费用（$0.01/次）与美国地域推理 1.1 倍系数。
- CodeBuddy / WorkBuddy：ACP 不上报逐次请求用量，打开会话和每轮结束后从原生历史读取，因此没有输出速度；WorkBuddy 自动路由的 `default-model` 不是具体模型，无法计价。
- 不计入：子代理、原生不给出模型的后台请求（如 OpenCode v2 的标题生成与压缩）、按次收费项目和长上下文分档价格。
- 分叉会话按原生历史计算，包含从父会话复制来的轮次；撤销上一轮后，被撤销轮次不再计入。

## 价格表

- 默认价格来自 [models.dev](https://models.dev)（MIT），随版本打包快照。
- Host 启动时若本地价格表超过 7 天，会在后台请求 `https://models.dev/api.json` 并缓存到 `<数据目录>/pricing/models-dev.json`；失败时静默沿用现有价格。
- 查找不做模糊匹配：先按“服务商/模型”，再按模型 ID。同一模型 ID 被多个服务商列出时，沿 `canonical_model_id` 链确定官方厂商；厂商自己列出该 ID 时用厂商价格，无法确定则视为未匹配。仅大小写不同的 ID（如 `Deepseek-v4-flash`）也能匹配，前提是各写法的价格一致。
- 更新打包快照：`npm run build:typescript && node packages/host-runtime/scripts/update-model-prices.mjs`。

数据目录默认是 `~/.codexhost`，可用 `CODEXHOST_DATA_DIR` 修改。

### 自定义价格

在数据目录创建 `pricing.json`，单位为美元 / 百万 Token，优先于默认价格：

```json
{
  "models": {
    "my-local-model": { "input": 0.5, "output": 1.5 },
    "anthropic/claude-sonnet-4-5": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 }
  }
}
```

键可以是模型 ID，也可以是 `服务商/模型 ID`。文件修改后下次刷新用量时生效；格式无效时整个文件被忽略，并在 Host 诊断日志中记录原因。

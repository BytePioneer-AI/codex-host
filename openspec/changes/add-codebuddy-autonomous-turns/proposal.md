# CodeBuddy 原生自主 Turn 的受限实时观测

## Why

CodeBuddy 与 WorkBuddy 的原生 unsolicited drain 可在没有 Host 请求时产生结果，共用 Session 需要承接这些实时输出。已核对发行的历史缺少通用的每 drain 轮标识，不能承诺重开后仍恢复同一分组与终态。

## What Changes

- 声明 `autonomousTurns.observe`，按同一连接的公告至 `session_end` 区间建立公共自主 Turn。
- 区间分别拥有内容和审批/提问；串行轮有界排队，真正重叠才 fault；Host Turn 与自主 Turn 保持互斥。
- 原生区间结束即完成实时生命周期，取消、关闭和故障沿用共享规则。
- 不从历史推断自主 Turn 的身份、成功或分组，不生成其 `nativeTurnRef`；只读历史保持已有投影，重开后的分组可能不同。

## Decisions

- B12 为受限支持：`succeeded` 仅表示收到原生区间终态，不证明业务成功。
- 全部待发布区间、帧和等待交互共享 2048 帧 / 4 MiB UTF-8 总额度，空区间也计入。
- 不引入持久化旁路、历史猜测规则或按发行配置的兼容分支。

## Capabilities

### New Capabilities

- `codebuddy-autonomous-turn-session`：共用 Session 的自主输出实时区间、互斥、交互和受限边界。

### Modified Capabilities

无。

## Impact

共用 CodeBuddy Adapter、其测试、WorkBuddy 的能力断言及两份集成文档。公共契约、Host、Renderer 与国内版插件不变；fork 国内版复用共享 Session 后受益。

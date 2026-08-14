# ACP 层后续开发说明

## 背景

codexhost 已通过 ACP v1 接入 Grok CLI。当前调用链是：

```text
Host Runtime
  -> HarnessAdapter
    -> GrokAdapter
      -> GrokAcpTransport
        -> @agentclientprotocol/sdk
          -> grok agent --no-leader stdio
```

`HarnessAdapter` 仍是 Host Runtime 唯一依赖的领域接口。ACP 只是 `GrokAdapter` 内部连接 Grok CLI 的通信协议，ACP 类型和 Grok `_meta` 字段不会进入 Host Runtime、Protocol Core 或 Renderer。

## 当前状态

当前没有独立、通用的 ACP package，也没有可直接注册的 `GenericAcpAdapter`。

ACP 相关实现位于：

```text
packages/adapters/grok/src/acp-transport.ts
```

它已经封装：

- Grok ACP stdio 子进程生命周期
- ACP initialize 和协议版本校验
- Session create/load/close
- Prompt、流式 Update 和 terminal response
- Permission request/response
- Cancel
- 超时、进程退出和启动错误分类
- Inspection 使用的 initialize/list 流程

这些代码具备未来抽取的基础，但当前接口、事件名和错误类型仍以 Grok 命名，不能视为稳定的共享 ACP 接口。

## 仍属于 Grok 的部分

以下语义必须继续留在 `packages/adapters/grok`：

- Grok 可执行文件查找和 `grok agent --no-leader stdio` 启动参数
- Grok 登录状态和错误文案识别
- `_meta.modelState`、`reasoningEfforts` 和 `totalTokens`
- Grok 扩展 `session/set_model`
- Grok Model、Thinking 和 Usage 投影
- Grok Native Session ID 与历史恢复规则
- Grok Tool 内容兼容处理
- Grok-specific RPC 和未来的 `x.ai/*` 扩展

共享 ACP 层不得通过增加大量 Grok 回调来隐藏这些差异。Harness-specific 语义应由具体 Adapter 明确拥有。

## 为什么现在不抽取

目前只有 Grok 一个生产 ACP Harness。现在抽取公共层只能依据单个实现猜测变化点，容易得到一个把 Grok 实现参数化的浅模块。

采用的原则是：

> 一个 Adapter 只有假设中的共享接口；两个真实 Adapter 才能暴露稳定的公共部分。

因此，应等第二个生产 ACP Harness 接入并完成最小实现后，再比较两套代码并抽取共同机制。

## 抽取触发条件

满足以下条件时开始设计共享 ACP 层：

1. 第二个 Harness 通过官方 ACP 接口接入，而不是只把 ACP 用于测试或兼容模式。
2. 两个 Harness 都真实使用了 Session、Prompt、Streaming、Permission、Cancel 和 close 生命周期中的主要部分。
3. 已验证两者在 capability、错误、配置、历史和进程退出方面的差异。
4. 抽取后具体 Adapter 仍然是 `HarnessAdapter` 的实现者，Host Runtime 不需要认识 ACP。

不要仅因为出现第二个 ACP 客户端文件就立即抽取。应先确认重复的是协议机制，而不是表面相似但语义不同的映射。

## 建议的共享范围

未来可考虑新增类似以下 package：

```text
packages/acp-transport/
```

它只负责 ACP 通信机制：

- 基于官方 SDK 建立连接
- 可配置的 stdio 子进程启动和关闭
- initialize 与协议协商
- Session new/load/close
- Prompt、Update、Permission 和 Cancel 的请求关联
- 超时、连接关闭和子进程故障
- 标准 ACP payload 的原样或轻量规范化传递

建议保持一个较小的 Transport 接口，例如围绕以下操作设计：

```text
inspect
open
prompt
cancel
close
requestExtension
```

最终接口必须由两个真实调用方共同推导，不应直接复制上面的草案。

## 不应进入共享层

共享 ACP 层不负责：

- 实现 `HarnessAdapter` 或生成 Host Event
- 决定 codexhost capability
- 解释 Harness-specific `_meta`
- 生成 Model、Thinking 或 Permission Mode 目录
- 构造历史 Snapshot 或稳定 Turn identity
- 推断 Unified Diff、Fork 或 Rollback
- 读取任何 Harness 的本地 Session 文件
- 将一个 Harness 的错误文本硬编码为通用错误语义

这些职责继续由各 Harness Adapter 持有。

## 推荐迁移步骤

接入第二个 ACP Harness 时按以下顺序推进：

1. 在新 Adapter package 内先完成最小 ACP Transport，不修改 Grok 实现。
2. 用真实 CLI 和 fixture 对比两者的 initialize、Session、Update、Permission、Cancel、close 和故障行为。
3. 列出完全相同的机制以及必须保留在各 Adapter 内的差异。
4. 为候选共享接口编写 contract tests，使用两个 Harness transport 实现运行。
5. 新建共享 package，并先迁移较简单的调用方。
6. 迁移 Grok，确认真实 create、Turn、Cancel 和 resume 冒烟结果不变。
7. 删除各 Adapter 中被共享层完全替代的代码，不保留双重兼容路径。

## 验证要求

共享层抽取完成前至少验证：

- 两个 Adapter 的聚焦测试
- ACP Transport contract tests
- Permission 请求与并发关联
- Cancel 后只有一个 terminal 结果
- 子进程异常退出和 bounded close
- create/load Session identity
- 两个 Harness 各一条真实合成 Prompt 冒烟
- Host Runtime、Protocol Core 和 Renderer 不新增 ACP 类型或事件分支

## 当前参考文件

- `packages/adapters/grok/src/acp-transport.ts`：当前 ACP 连接和进程机制
- `packages/adapters/grok/src/grok-adapter.ts`：ACP 到 `HarnessAdapter` 领域事件的 Grok 投影
- `packages/adapters/grok/src/grok-models.ts`：Grok Model/Thinking 元数据解释
- `packages/adapters/grok/src/grok-usage.ts`：标准 ACP 与 Grok Usage 映射
- `packages/adapters/grok/src/grok-history.ts`：Grok ACP replay 到 Snapshot 的映射
- `packages/adapters/grok/test/grok-adapter.test.ts`：当前 Adapter 测试入口
- `docs/grok-cli-adapter-integration.md`：Grok 接入背景和能力分析
- `openspec/changes/integrate-grok-cli-acp-mvp/design.md`：MVP 的架构决策

## 决策摘要

- 当前：ACP Transport 私有于 `GrokAdapter`，没有通用 ACP 层。
- 保持：`HarnessAdapter` 是 Host Runtime 唯一领域抽象。
- 触发：第二个生产 ACP Harness 出现并验证差异后再抽取。
- 目标：共享 ACP 通信机制，不共享 Harness-specific 领域语义。

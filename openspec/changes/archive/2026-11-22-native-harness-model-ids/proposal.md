# Proposal

## Why

共享契约只允许 Model Ref 使用 `[A-Za-z0-9._~-]`，各 Harness 的原生 Model ID 却不受这个限制，例如 `xai/grok-4.6`、`GLM-5.3-flash(openai)`、`kimi/k3[1m]`。结果是每个 Adapter 都各自编码或改写 ID：Codex、Hermes、Copilot、Kimi 等做 base64，Qwen 做替换并维护映射表。这让用户在 CLI 和界面里看到编码后的 ID，Adapter 里也积累了重复的编解码代码。这个限制是 Pi Model 目录引入时的保守选择，不是传输上的硬性约束。

## What Changes

- **BREAKING（契约）** Model Ref ID 改为任意非空字符串：不含控制字符，最长 512，空格和 Unicode 原样保留。单值身份的 Harness 直接使用原生 Model ID 作为 Ref。
- Model Ref 增加可选的服务档位字段。Codex 的 Fast、Ultrafast 改用这个字段表达，不再编码进 ID。CLI 的 `~fast`、`~ultrafast` 保留为输入简写。
- 承载 Model 的路由载体（Desktop 草稿创建、计划任务、Web 新建、Host 恢复）对任意合法 Model 身份都要无损往返，包括 `@`、`/`、非 ASCII 字符。长度预算按"最长 Ref 加上其他配置"统一。
- 单值身份的 Adapter 停止写入编码后的 Ref，只保留读取旧编码 Ref 的能力：Codex、Claude Code、Qoder、Qoder CN、Kimi、Copilot、Hermes、CodeBuddy、WorkBuddy、Devin、Grok。Qwen 去掉字符替换和映射表。组合身份的 Adapter 继续由 Adapter 自己无损表达"Provider + Model"等组合：Pi、OMP、OpenCode、DeepSeek、ZCode、Cursor。
- 本机已保存的旧 Ref 读取时归一为新形式，包括偏好、收藏、委派默认、Thread 记录和委派去重摘要。不批量改写文件。

## Decisions

- **不处理新旧版本混用。** 用户确认混版概率很低。新版本不为旧 Desktop、旧远程 Host 或旧插件生成兼容投影，也不做能力协商；只保证本机旧数据能读。
- **档位使用独立字段，不使用 ID 后缀。** 原生 ID 本身可能以 `~fast` 结尾，后缀无法无歧义地同时表达字面 ID 和档位。`~fast` 只是 CLI 简写，由 Host 按目录解析成档位字段。
- **组合身份仍归 Adapter 所有。** 放宽字符集只去掉单值编码，不把"Provider + Model"拆进共享契约，避免公共层理解 Harness 语义。
- **Qwen 无法确定的旧别名不猜。** 旧的替换形式（如 `foo-bar-2`）依赖当时的目录顺序。对应关系不唯一时视为不可用，由已有的"保存值失效即回退默认"处理，用户重新选择即可。

## Capabilities

### Modified Capabilities
- `harness-model-catalog`：Model Ref 的字符集、服务档位、路由载体往返，以及旧 Ref 的读取。

## Impact

- `shared-contracts`：Model Ref schema、服务档位字段、路由载体编码与长度预算。
- `protocol-core`：Pi、OMP、OpenCode 等专用载体的解析。
- `host-runtime`：Codex 目录与选择、委派解析与去重摘要、CLI 输出、偏好读取。
- `harness-plugin-files`、`mapping-store`：已保存的旧 Ref 在读取时归一。
- `renderer-extension`、`web-server`、`apps/web-ui`：档位关联与 Model 匹配改为比较完整选择。
- `packages/adapters/*`：上面列出的单值 Adapter 和 Qwen。
- 文档：`docs/architecture/external-clients.md`，以及 Harness 模型相关文档。

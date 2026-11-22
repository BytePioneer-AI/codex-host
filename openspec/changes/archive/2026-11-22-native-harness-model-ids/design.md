# Design

## Context

- 字符集只在 `shared-contracts` 定义一次，但多处依赖了它：
  - 通用插件路由载体把 JSON 的每个 UTF-16 单元写成两位 hex，非 ASCII 字符会被截断，且仍能通过规范性校验。
  - Pi、OMP、OpenCode 的专用载体用 `@` 切分 Model 和 Thinking/Permission。
  - Mapping Store 的载体上限是 1024，Thread Inspection 的上限也是 1024，路由解码上限是 4096。512 字符的 Ref 编码后可能超出前两者，导致"已应用但未保存"。
- 各 Adapter 绕过这个限制的方式不同：
  - Codex：base64url 加档位前缀。
  - Hermes、Copilot：无前缀的 base64。
  - Grok：条件编码。
  - Qwen：字符替换加映射表，结果依赖目录顺序。
- 委派去重摘要对规范 Ref 做 `JSON.stringify` 后取 SHA-256。Ref 的形式一变，摘要就变。

## Decisions

- **路由载体改为对 UTF-8 字节编码**，可以用 base64url 或逐字节 hex。理由是无损，而且不依赖字符集。专用载体不再用字符切分，改成结构化编码（JSON 后整体编码），或者保证分隔符不会出现在被切分的部分里。放弃的做法：继续沿用逐字符 hex 再扩大上限，因为非 ASCII 仍然会损坏。
- **长度预算从最长输入倒推。** Ref 最长 512 UTF-16 单元，最坏情况下 UTF-8 是 1536 字节，编码后再加上 Thinking、Permission 和外层。载体、Mapping Store 和 Thread Inspection 的上限统一为能容纳这个最坏情况的值。
- **档位放在 Model Ref 对象上**，作为可选的 `serviceTier`。Ref 的比较（目录匹配、档位关联、收藏、偏好、去重）一律比较完整的 Ref 对象，不只比较 ID，并提供一个共享的比较函数供各处复用。放弃的做法：新开一个与 Ref 并列的选择字段，因为那样每个携带 Ref 的接口都要改签名。
- **旧数据在读取边界归一，按"来源 Harness"选择解码器。**
  - Copilot、Hermes 的旧编码没有前缀，只能结合它所属的 Harness 判断，所以每个 Adapter 提供一个"旧 Ref 转当前 Ref"的只读入口，由 Host 在读取已保存的选择时调用。
  - 去重摘要使用归一后的形式。对于新版本上线前发起、还在短时去重窗口内的请求，接受摘要不匹配带来的一次重复委派，不为此保留双摘要。
- **组合身份的 Adapter 不改编码方案**，只验证各组成部分在放宽后的字符集下依然能往返。

## Risks / Trade-offs

- [某个消费方仍隐含依赖 ASCII 或长度] → 以契约测试覆盖：含 `@`、`/`、`:`、空格、中文的 ID，以及 512 长度的 ID，逐一走完草稿创建、计划任务、Web 新建、Host 恢复、Thread 切换和保存。
- [原生 CLI 参数边界] → 有 Adapter 用 argv 传 Model（Grok 启动时会 trim；Windows 的 `.cmd`/`.bat` 会经过 `cmd.exe` 转义）。这些 Adapter 增加带空格和特殊字符的参数测试；如果原生端本身不接受，在 Adapter 内拒绝并给出明确错误，不在公共层限制。
- [Qwen 旧别名失效] → 只影响无法唯一确定的旧值，回退到默认，用户重新选择即可。

## Migration

- 不改写任何已保存的文件。新写入一律使用新形式，旧形式只在读取时归一。
- 回滚到旧版本不在支持范围内（见 proposal 的 Decisions）。

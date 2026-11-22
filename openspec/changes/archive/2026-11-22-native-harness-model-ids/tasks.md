# Tasks

## 1. 共享契约与载体

- [x] 1.1 `shared-contracts`：Model Ref ID 改为非空、无控制字符、最长 512 的字符串；新增可选 `serviceTier`；提供比较完整 Ref 的共享函数，并替换目录匹配处的纯 ID 比较。验证：契约测试覆盖 `@`、`/`、`:`、空格、中文的合法用例，控制字符和超长的拒绝用例，以及同 ID 不同档位不相等。
- [x] 1.2 通用插件路由载体改为对 UTF-8 字节做无损编码；统一载体、Mapping Store、Thread Inspection 的长度上限，确保能容纳 512 长度的 Ref 加上其他字段。验证：载体往返测试覆盖中文 ID 和 512 长度的 Ref；Mapping Store 保存并读回 512 长度 Ref 的 Thread。
- [x] 1.3 `protocol-core`：Pi、OMP、OpenCode 专用载体不再按 `@` 切分 Model 身份。验证：含 `@` 的 Model ID 加 Thinking/Permission 时，解析结果完全一致。

## 2. Codex

- [x] 2.1 Codex 目录直接使用原生 Model ID；Fast、Ultrafast 改用 `serviceTier`；旧编码 Ref（含三种前缀）只读归一；CLI 的 `~fast`、`~ultrafast` 解析为档位，`inspect` 输出原生 ID 加后缀。验证：现有 `official-codex-model-ref`、委派 CLI、headless delegation 测试改为断言新形式，并保留旧 Ref 输入用例。
- [x] 2.2 Web 的档位关联、远程会话控件、委派去重摘要改为比较完整的 Ref。验证：Web Fast 开关切换、同模型跳过更新的测试；用旧 Ref 和原生 ID 以同一 request ID 重试，结果视为同一请求。

## 3. Adapter

- [x] 3.1 单值 Adapter 停止编码，并各自提供"旧 Ref 转当前 Ref"的只读入口：Claude Code、Qoder、Qoder CN、Kimi、Copilot、Hermes、CodeBuddy、WorkBuddy、Devin、Grok。验证：每个 Adapter 的目录测试断言 Ref 等于原生 ID，旧 Ref 输入仍选中同一 Model；用 argv 传 Model 的 Adapter 补一个含空格和特殊字符的参数测试。
- [x] 3.2 Qwen 去掉字符替换和映射表；旧别名能唯一对应就归一，不能则视为不可用。验证：`GLM-5.3-flash(openai)` 原样往返；歧义的旧别名回退到默认，且不阻断 Thread。
- [x] 3.3 组合身份 Adapter（Pi、OMP、OpenCode、DeepSeek、ZCode、Cursor）保持现有方案，只验证放宽后各组成部分能无损往返。验证：每个 Adapter 增加一个含 `/` 和中文的组成部分用例。

## 4. 已保存数据与文档

- [x] 4.1 偏好、收藏、委派默认值、Thread 记录读取时，通过对应 Adapter 的只读入口归一，不改写文件。验证：用旧 Ref 写好的偏好文件，读出来是新形式，文件内容不变；设置页显示为当前选择。
- [x] 4.2 更新 `docs/architecture/external-clients.md` 和相关 Harness 模型文档，说明 Model ID 原样使用、档位字段和 CLI 简写。验证：文档描述与 1.1、2.1 的行为一致。
- [ ] 4.3 隔离环境实测：在独立数据目录的 Web 中，选择 Qwen 的带括号 Model 和 Codex Fast，各发一条消息，重启 Host 后恢复。验证：Model 与档位保持不变，界面里不出现编码后的 ID。

# Tasks

## 1. 契约与公共类型

- [x] 1.1 在 `@codexhost/shared-contracts` 中定义 `claudeCodeProfileSchema`、`claudeCodeProfilesFileSchema` 与相应 TypeScript 类型，确保跨包与浏览器安全。
- [x] 1.2 在 `@codexhost/harness-adapter` 的 `HarnessPluginContext` 中补充可选 `harnessId`。

## 2. Profile 配置发现与文件读取

- [x] 2.1 在 `@codexhost/harness-plugin-files` 中实现安全发现与解析 `claude-code-profiles.json` 的功能，支持路径展开（`~`）与外部图标（SVG/PNG/Data URL）解析与安全校验，并将 profiles 候选注入 `discoverHarnessPlugins`。
- [x] 2.2 编写针对 Profile 配置解析、异常容错与图标转换的单元测试。

## 3. Claude Code Adapter 参数化与变体支持

- [x] 3.1 改造 `packages/adapters/claude-code/src/claude-code-adapter.ts`，接收可选 `harnessId`，并在 Session、Turn、Native Ref、Import 等生命周期中使用实例身份，对 SDK 原生存储调用进行 `CLAUDE_CONFIG_DIR` 隔离绑定。
- [x] 3.2 改造 `pending-session.ts`、`claude-history.ts` 与 `claude-session-import.ts`，支持绑定非 `"claude-code"` 的 Harness ID。
- [x] 3.3 在 `packages/adapters/claude-code/src/plugin.ts` 中根据 `context.harnessId` 绑定对应 Profile，且先获取基础用户 Shell 环境再叠加 Profile 变量，杜绝污染共享 Shell 缓存；若配置不存在显式拒绝。
- [x] 3.4 编写针对 `ClaudeCodeAdapter` 参数化实例与变体生成的单元测试，验证独立 `harnessId`、`CLAUDE_CONFIG_DIR` 与环境隔离。

## 4. Host Runtime 动态集成

- [x] 4.1 在 `packages/host-runtime/src/harness-plugin-loader.ts` 中向 `loadAdapter` 传递 `harnessId`，使 Profile 候选按指定身份实例化，原生支持 `options.onlyIds` 过滤。
- [x] 4.2 编写 Host Runtime 加载包含 Profiles 的插件集成测试。

## 5. Renderer 扩展与向后兼容

- [x] 5.1 在 `packages/renderer-extension/src/renderer-permission-mode-preference.ts` 中支持按 `harnessId` 独立存储/读取权限模式偏好；在 `renderer-binding-probe.ts` 中传入当前 `agent`。
- [x] 5.2 验证原生 `claude-code` 单元测试与端到端测试无回归，运行 `npm run lint` 与 `npm run typecheck`。

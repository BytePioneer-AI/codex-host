# Tasks

## 1. 契约与公共类型

- [ ] 1.1 在 `@codexhost/shared-contracts` 中定义 `claudeCodeProfileSchema`、`claudeCodeProfilesFileSchema` 与相应 TypeScript 类型，确保跨包与浏览器安全。
- [ ] 1.2 在 `@codexhost/harness-adapter` 中扩展 `HarnessPluginModule`，声明 `createHarnessProfiles?` 方法与 `HarnessPluginProfile` 结构；在 `HarnessPluginContext` 中补充可选 `harnessId`。

## 2. Profile 配置发现与文件读取

- [ ] 2.1 在 `@codexhost/harness-plugin-files` 中实现安全发现与解析 `claude-code-profiles.json` 的功能，支持路径展开（`~`）与外部图标（SVG/PNG/Data URL）解析与安全校验。
- [ ] 2.2 编写针对 Profile 配置解析、异常容错与图标转换的单元测试。

## 3. Claude Code Adapter 参数化与变体支持

- [ ] 3.1 改造 `packages/adapters/claude-code/src/claude-code-adapter.ts`，接收可选 `harnessId`，并在 Session、Turn、Native Ref、Import 等生命周期中使用实例身份。
- [ ] 3.2 改造 `pending-session.ts` 与 `claude-history.ts`，支持绑定非 `"claude-code"` 的 Harness ID。
- [ ] 3.3 在 `packages/adapters/claude-code/src/plugin.ts` 中实现 `createHarnessProfiles`，读取配置并根据 Profile 构造对应的变体 Adapter 与 Descriptor。
- [ ] 3.4 编写针对 `ClaudeCodeAdapter` 参数化实例与变体生成的单元测试，验证独立 `harnessId` 和 `CLAUDE_CONFIG_DIR`。

## 4. Host Runtime 动态集成

- [ ] 4.1 在 `packages/host-runtime/src/harness-plugin-loader.ts` 中接入 `createHarnessProfiles`，在加载模块后注册返回的 Profiles 到 `HarnessPluginRegistry`，支持 `options.onlyIds` 过滤。
- [ ] 4.2 编写 Host Runtime 加载包含 Profiles 的插件集成测试。

## 5. Renderer 扩展与向后兼容

- [ ] 5.1 在 `packages/renderer-extension/src/renderer-permission-mode-preference.ts` 中支持按 `harnessId` 独立存储/读取权限模式偏好；在 `renderer-binding-probe.ts` 中传入当前 `agent`。
- [ ] 5.2 验证原生 `claude-code` 单元测试与端到端测试无回归，运行 `npm run lint` 与 `npm run typecheck`。

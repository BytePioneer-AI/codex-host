## 1. 共享契约

- [x] 1.1 增加严格的浏览器安全 Thinking option, catalog, capability, state, inspection, and selection schemas.
- [x] 1.2 扩展 Shared Contracts tests and public exports for valid relationships, strict rejection, and method-specific params.

## 2. Harness 契约

- [x] 2.1 增加 Thinking 创建输入, Session state, capability, command, result, and execute overloads to HarnessAdapter.
- [x] 2.2 扩展 Fake HarnessAdapter and contract tests with serialized Thinking selection and complete state events.

## 3. Pi 原生映射

- [x] 3.1 解析 Pi `thinkingLevel`, available levels, optional unsupported commands, and Model-target startup arguments in PiRpcSession.
- [x] 3.2 根据 Pi Model `reasoning` 规范化统一 Draft Thinking options及逐Model支持关系，不引入Provider或Model白名单。
- [x] 3.3 实现 Pi 检查, create/resume/fork state recovery, Model side-effect readback, corrected Thinking selection, and Idle serialization.
- [x] 3.4 增加针对性的 Pi RPC, catalog, Adapter ordering, correction, unsupported-command, and lifecycle tests.

## 4. 协议与 Host

- [x] 4.1 扩展 Pi transport carrier to bind optional Thinking with Model while preserving existing carrier forms.
- [x] 4.2 增加通用固定 Thread Thinking selection routing and complete configuration state projection in Host Runtime.
- [x] 4.3 覆盖 carrier validation, create/Turn binding, capability rejection, Model correction, Thinking correction, resume, and transparent Codex routing.

## 5. Renderer

- [x] 5.1 扩展 Renderer client and logical Composer state with confirmed Thinking inspection, selection, restore, transfer, reset, and stale-generation handling.
- [x] 5.2 重建 Pi picker as one Codex-style Model/Thinking trigger with Thinking radio choices and a nested Model submenu using native token classes.
- [x] 5.3 Add focused Renderer client, state, binding, presentation, disabled-state, and unsupported-option tests.

## 6. 验证与文档

- [x] 6.1 执行针对性的包测试, TypeScript build/typecheck, lint/format checks, strict OpenSpec validation, and `git diff --check`.
- [x] 6.2 执行有界的真实 Pi RPC smoke check for actual available levels, corrected readback, and cleanup without recording private catalog data.
- [x] 6.3 更新受影响的架构/状态文档 with implemented scope and checks actually executed.

## 7. Pi Draft Thinking Catalog 简化

- [x] 7.1 将 Pi Draft Catalog 改为一次读取 Model `reasoning` 并生成 Paseo 风格统一 Thinking 选项，删除逐目标 Model inspection 语义。
- [x] 7.2 让 Draft Model 切换只使用内存 Catalog 更新 Composer carrier，同时保留 Native Session 内由 Pi 执行的 Thinking 校正和状态回读。
- [x] 7.3 更新 Shared Contracts、Pi Adapter、Renderer 和相关聚焦测试，覆盖 reasoning/non-reasoning Model、无目标Pi inspection的Draft切换及严格Catalog关系。
- [x] 7.4 同步 change artifacts、开发状态与验证记录，区分Desktop注入readiness和真实交互Gate，并执行聚焦测试、typecheck、lint、strict OpenSpec validation 和 `git diff --check`。

## Why

用户常不了解 CodexHost 支持跨 Harness 多 Agent 委派，且目前每次委派若不显式指定模型，只能沿用各 Harness 自己的原生默认，无法在设置中统一配置「某个 Harness 被委派时默认使用的模型与思考强度」。

## What Changes

- **共享偏好扩展**：在既有 Harness 偏好文档（`harness-preferences-v1.json`）的 `values` 下新增独立的 `delegation.byHarness` 映射与按 Harness 替换/清空的 patch 操作，与普通新会话偏好 `newThread` 隔离；支持包含官方 `codex` 在内的所有 Harness。
- **委派启动合并默认值**：在最终创建委派子 Thread 的 Host 入口按「本次显式指定 › 委派默认设置 › Agent 自己的默认」合并模型与思考强度；显式指定模型但不指定思考强度时不套用旧默认模型的思考强度；已保存默认若因模型下架/换号失效，静默回退到 Agent 自己的默认；调用方原始 `requestId` 去重语义不变，CLI 协议与参数不变。
- **双端共用「委派」设置页**：在 `packages/renderer-extension` 新增「委派」设置页（采用 8792 设计方案：多 Agent 委派回流示意图、`#` 唤起委派示例、被委派时的默认模型列表），并接入 Codex Desktop 设置页与 Web 设置页（通过 `codexhost-settings.js` 共用）。
- **轻量列表与按需目录读取**：页面复用本机连接诊断缓存，只展示内置 Codex 与本机已就绪的 Harness；首屏不并发探测所有模型，点击/展开某行下拉时再按需调用既有 `codexhost/harness/inspect` 获取模型与思考强度列表。

## Decisions

- **只展示可配置 Agent**：设置页仅展示内置 `codex` 与本机已就绪的外部 Harness，不引入「待连接」折叠区，保持页面纯粹。
- **未覆盖文案**：未自定义时显示「跟随 Agent 默认」，不做首屏模型探测，也不拿列表首项冒充原生默认。
- **已存覆盖失效静默回退**：已保存的委派默认确认失效时静默回退到 Agent 原生默认，不弹窗提醒、不阻断委派；单次委派显式传入非法 `--model`/`--thinking` 仍保持报错拒绝。
- **不改网关拦截与 Adapter 缓存**：继续由既有 `codexhost/harness/inspect` 与各 Adapter 自身内存缓存提供热读，不新增落盘模型缓存或网关方法拦截。

## Impact

影响 `shared-contracts`、`harness-plugin-files`、`host-runtime`、`renderer-extension` 与 `apps/web-ui`（Web 设置页入口注册）；不改变 CLI 参数协议、Adapter 契约、`mapping-store` 或 `web-server` 网关拦截行为。

# Tasks

## 1. Launcher 配置与双端路由

- [x] 1.1 为版本 1 偏好增加向后兼容的 `rememberDefault`，扩展 `launch-prefs get/set` 与严格参数校验；旧配置默认不记忆，显式 CLI set 默认记忆。验证：`cargo test --package codexhost-launcher --locked` 覆盖读写与 CLI 合同。
- [x] 1.2 普通启动仅在明确记忆时进入单一默认入口，覆盖双端相同路由、旧配置、未记忆、官方缺失与无壳回退。验证：同一 Launcher 聚焦测试通过。

## 2. 桌面壳桥接与托盘

- [x] 2.1 选择页 IPC 传递记忆值，`getState` 返回已保存状态；双端托盘提供三个选项、选中状态与过期异步读取丢弃。Windows 真实 Tauri 隔离验证已覆盖复选框、托盘三态和 Onboarding 左键进入 loading；Cargo 测试编译成功，但测试 EXE 仍以 `STATUS_ENTRYPOINT_NOT_FOUND` 退出且未进入断言，macOS 也未验证，这些环境限制保留记录。
- [x] 2.2 保持显式原生入口语义，普通原生默认重开可离开选择页，不引入 Windows 专用路由或 `both`。

## 3. 选择页与文档

- [x] 3.1 在选择页加入中英双语记忆复选框、忙碌状态与窄屏样式，对接新 IPC；检查离线预览与手机宽度布局。
- [x] 3.2 更新 `docs/product/standalone-web.md` 的当前启动行为与配置合同，并校验本 OpenSpec 变更。

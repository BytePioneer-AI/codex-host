# Tasks

- [x] 在 `ui-session` 增加手动设置完成未读提醒的服务操作，保持现有自动添加与清除规则不变。
- [x] 在 `ui-workspace` 增加“标记为未读 / Mark as unread”内置菜单组件、状态条件、注册和中英文文案。
- [x] 更新 `docs/product/standalone-web.md` 的现行行为说明。
- [x] 运行 OpenSpec 校验和 Web UI 构建，记录实际结果。
- [x] 在父会话菜单中增加“将子对话全部标为已读 / Mark all child threads as read”，仅在至少一个已加载后代显示未读提醒时出现。
- [x] 复用父行 `descendantIds` 和 `markCompletionsRead`，保持父会话、旁支、当前选择、运行及展开状态不变。
- [x] 更新现行行为文档并校验 OpenSpec。
- [x] 在隔离假 Host 的 Chromium Web 页面验证 1360×890 桌面和 393×852 手机抽屉：手动标记、批量清除、运行中子会话不提供手动未读或提前触发父级批量项、显示已归档时不计入归档残留未读；两个宽度均已截图。
- [x] 验证树投影不把运行中、原生子代理仍在运行、等待交互或已归档行的隐藏提醒计入未读；等待交互状态由投影断言覆盖，未在浏览器夹具中呈现。

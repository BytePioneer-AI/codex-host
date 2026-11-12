# Proposal

## Why

手机 Web 发送附件需要即时反馈、明确进度和不丢内容的重试体验。附件上传与消息提交各自展示实际状态，避免用户等待时误以为界面卡住。

## What Changes

- 图片选中即二进制上传，发送时仅引用会话凭证，保留图片校验、存储、转录区预览和 Harness 图片清单语义。
- 上传中允许发送，立即展示本地消息，全部附件就绪后按原 queue/steer 模式提交。
- 输入框及待发送消息逐附件展示进度；失败恢复完整草稿并提供重试、移除。
- 页面回到前台时，每个传输失败附件自动重试一次；明确拒绝的附件不自动重试。

## Decisions

- 图片使用现有文件凭证提交格式，上传请求显式声明图片；不修改固定协议快照或未挂载的上游 DSH 执行代码。
- 新草稿在前、失败文字在后，以空行分隔；附件全部恢复，不做部分发送。
- 不增加压缩、续传、持久化或 Agent 处理中提示。

## Capabilities

### New Capabilities

- `web-attachment-submission`: Web 附件预上传、发送等待、进度和失败恢复。

### Modified Capabilities

无。现有主规格没有附件提交需求。

## Impact

`packages/web-server` 的上传与输入组装，以及 Web UI 的 file-upload、ui-conversation、ui-attachment、ui-chat 和本地 submission 契约；不增加包或依赖，不修改 docs。

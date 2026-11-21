# Design

## Context

CH Web 的聊天与二进制上传由 web-server 承接；嵌入 DSH 后端仅承担 workspaceFiles、officeToPdf、terminal，不挂载上游 Agent 图片准入。固定协议中的图片需要编码数据，文件支持上传凭证。图片本地预览和传输表示相互独立。

## Decisions

- 复用 file-upload Worker、并发队列和 fileUploads 状态。图片上传显式携带图片媒体类型，消息无条件使用 `{ type: "file", receiptId }`，不修改固定编解码快照。
- WebFiles 的会话凭证记录图片引用。图片在上传期间检查字节上限，完成时复用 inspectImage 校验并写入 WebImages 目录。发送时重新验证图片，并汇总编码图片与凭证图片的消息级限制；清单按 parts 顺序编号。队列展示将图片凭证映射为 localImage。
- 上传等待归 ConversationController，绑定选定的附件和 SessionFace，而非当前可见会话。附件提交期间持有 controllerOperation SessionReference，切换视图不释放输入 shell 或中止提交。普通提交先 beginSubmission，再等待；命令序列化也等待同一队列。上传已完成时不等待额外事件。
- 本地 submission 附件携带可观察上传状态供气泡订阅，不把浏览器草稿身份带到 Host。输入框和气泡保留缩略图，复用 FileCard 的进度、错误与重试表现。
- 上传错误区分传输失败和业务拒绝；Conversation 服务拥有一个 visibilitychange 监听及每附件一次自动重试预算。显式手动重试仍可用。
- 统一扩展现有失败恢复：空草稿按原快照恢复，已有新文字则保留其引用并将失败文字及引用追加其后。新文字作为恢复前缀，失败消息保持提交顺序。附件沿用 restoreAttachments。最后一个 SessionReference 释放后 scope 销毁，晚到失败不在其他会话提示，不持久化失败消息。

## Risks / Trade-offs

- [凭证跨会话使用] → 保持会话所有权校验、到期机制和发送前完整性校验。
- [等待期间用户继续编辑] → 失败内容追加，不覆盖新输入；现有生命周期结束后不新增离线草稿存储。
- [客户端与服务端版本配对] → Web UI 与上传服务同时部署；编码图片服务端入口保留兼容。

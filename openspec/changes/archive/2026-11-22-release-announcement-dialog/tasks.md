# Tasks

## 1. 数据与 Host

- [x] 1.1 `shared-contracts`：定义 `ReleaseAnnouncement` schema 和两个 RPC 的参数、返回 schema，并把 RPC 名称加入 Web 客户端通道（`client-channel.ts`）的允许列表；Desktop 控制通道在 `host-runtime` 放行，Console 不需要。验证：`npx tsc -b packages/shared-contracts`。
- [x] 1.2 `update-manager`：按版本读取正式 GitHub Release（草稿、预发布、Tag 不符都视为无公告）。实现解析正文的纯函数，按 spec 拆分中英文、总结、主题和贡献者。验证：聚焦单测，用 v0.24.0 新版正文、旧格式正文、只有一种语言、预发布这几种情况做夹具。
- [x] 1.3 `host-runtime`：实现 `codexhost/announcement/get` 和 `codexhost/announcement/acknowledge`。已读版本持久化到 `release-announcement-v1.json`；已读后的非手动查询不访问 GitHub；进程内只缓存成功结果。验证：聚焦单测，覆盖已读后不请求网络、确认非当前版本被拒绝、失败不缓存。

## 2. 界面

- [x] 2.1 `renderer-extension`：参照 Cindy 的版式实现“更新公告”对话框，包括版本号、日期、总结、主题卡片（图标、标题、右侧贡献者、说明）、“我知道了”按钮和完整说明链接。`Esc` 可关闭，点遮罩不关闭，手机宽度下可滚动；补充中英文 locale。验证：preview HTML 在桌面和手机宽度下截图。
- [x] 2.2 Desktop 启动时查询公告，未读就弹出，关闭时确认已读。设置“更新”页新增“查看本版公告”入口，从这里打开不改变已读记录。验证：用隔离 Desktop 或 preview 实测。
- [x] 2.3 Web：`ui-codexhost` 连上 Host 后通过 `web-settings-entry` 弹出同一个对话框；如果 `web-server` 需要转发，同步放行这两个 RPC。验证：用隔离 Web 实测首次弹出、确认后刷新不再弹、另一个标签页不弹、离线不弹。

## 3. 文档

- [x] 3.1 更新 `docs/` 里的更新功能文档，并在 `codexhost-release` Skill 中写明：Release 正文开头的主题会作为应用内更新公告；正式发布后修改 Release 正文，只影响尚未确认的用户和手动查看。（由主会话编写）

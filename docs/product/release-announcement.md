# 更新公告

升级 codexhost 后，第一次打开 Desktop 或 Web 时会弹出“更新公告”，按主题介绍当前版本的变化和贡献者。规格见 [`openspec/specs/release-announcement/spec.md`](../../openspec/specs/release-announcement/spec.md)。

## 内容来源

- 公告取自**当前运行版本**对应的 GitHub Release（`v<版本>`），不是最新版。草稿、预发布、不存在的 Release，以及正文里没有主题的 Release，都不弹。开发版本（如 `0.24.0-dev`）没有对应的 Release，同样不弹。
- 正文按 [`codexhost-release`](../../.agents/skills/codexhost-release/references/release-guide.md) 模板写作：以第一条 `---` 为界，前面是中文，后面是英文。每种语言只取第一个 `## ` 标题之前的部分：
  - 第一段是总结；
  - 每个 `### <图标> <标题>` 开始一个主题，标题下面是说明；
  - 以 `— ` 开头的一行是贡献者。
- 由 Host 读取并解析（`update-manager` 的 `parseReleaseAnnouncementMarkdown`），界面拿到的是 `shared-contracts` 里定义的结构化 `ReleaseAnnouncement`。同一个 Host 进程中，每个版本只成功读取一次。GitHub 请求超时为 15 秒，界面等待 20 秒。

## 何时弹出

- Desktop 的注入界面和 Web 连上 Host 后，各自调用一次 `codexhost/announcement/get`。返回 `unread: true` 时弹出。
- 点“我知道了”或按 `Esc` 关闭，会调用 `codexhost/announcement/acknowledge` 记为已读；点击遮罩不会关闭。
- 已读版本保存在 Host 数据目录的 `release-announcement-v1.json`，Desktop 和 Web 共用。任何一端确认后，其他端、其他标签页都不再弹出。已读之后，Host 不再为自动弹窗访问 GitHub。
- 全新安装、没有已读记录时，也会弹出当前版本的公告。
- 读取失败（离线、限流）时不弹，也不记为已读，下次启动或重新连接时再试。
- 只显示当前版本的公告。跨多个版本升级的用户，可以从公告里的“查看完整更新说明”去看 GitHub Releases。

## 手动查看

设置的“更新”页有“查看本版公告”入口，以 `{ manual: true }` 读取公告；当前版本有公告时才显示这个入口。从这里打开和关闭都不改变已读记录。

## 发布后修改公告

在 GitHub 上修改 Release 正文后，还没确认已读的用户在下次启动时会看到新内容，所有人都能通过手动查看读到新内容；已经确认过的用户不会再自动弹出。

## 界面

对话框实现在 `packages/renderer-extension/src/settings/release-announcement-dialog.ts`，Web 通过 `web-settings-entry` 复用同一个组件。用 `release-announcement.preview.html` 预览（需要先构建 `dist/web-settings.js`）。

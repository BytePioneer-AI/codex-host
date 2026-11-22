# Design

## Context

- 现有更新检查（`codexhost/update/check`）通过 `update-manager` 读取 GitHub `/releases/latest`，返回的 `releaseNotes` 属于最新版，不是当前运行版本（`packages/update-manager/src/github-release.ts`、`packages/host-runtime/src/update-coordinator.ts`）。公告不能复用这份数据。
- Desktop 注入界面在设置生命周期里会检查更新（`renderer-settings-lifecycle.ts`）；Web 的 `ui-codexhost` 连上 Host 后也会检查（`SettingsLauncher.tsx`），并通过 `web-settings-entry.ts` 复用 Renderer 的设置页。两端已经共用一套设置界面代码。
- Host RPC 要经过多个允许列表：`shared-contracts` 的 `client-channel.ts` 和 `console.ts`，以及 `host-runtime` 的 `desktop-control-requests.ts`。

## Decisions

- **两个 RPC。**
  - `codexhost/announcement/get`，参数 `{ manual?: boolean }`。返回 `{ announcement: ReleaseAnnouncement | null, unread: boolean }`。
    - 非手动查询时，如果已读版本等于当前版本，Host 直接返回 `{ announcement: null, unread: false }`，不访问 GitHub。这样已读后的每次启动都不产生网络请求，也避开 GitHub 未认证接口的限流。
    - 手动查询（设置页入口）总是读取公告。
  - `codexhost/announcement/acknowledge`，参数 `{ version }`，只接受当前运行版本。
- **`ReleaseAnnouncement` 的结构**由 `shared-contracts` 定义：`version`、`publishedAt`、`url`，以及 `zh`、`en` 两个可空的 `{ summary, themes: [{ icon?, title, body, contributors: string[] }] }`。字段都有长度上限，主题数量上限为 12，防止异常正文撑爆界面。
- **读取与解析放在 `update-manager`**，与现有的 GitHub Release 读取放在一起。
  - 请求 `/releases/tags/v<version>`，复用现有的超时设置和响应校验写法。
  - 解析是纯函数，输入 Markdown，输出两种语言的公告。
  - 进程内缓存只保存成功的结果。
- **已读版本保存在 Host 数据目录下单独的 `release-announcement-v1.json`**，内容为 `{ "acknowledgedVersion": "0.24.1" }`，按现有偏好文件的方式原子写入。不放进 Harness 偏好文件，因为两者的含义和归属都不同。
- **对话框只实现一次，放在 `renderer-extension`**，用现有的 DOM 写法和设置页样式变量，并像设置页一样通过 `web-settings-entry` 提供给 Web。
  - Desktop 在设置生命周期启动、拿到 Host 连接后查询一次公告。
  - Web 在 `ui-codexhost` 连上 Host 后查询一次公告。
  - 同一页面生命周期内只弹一次。
- **界面语言**沿用设置页现有的 locale 判断：中文界面优先用 `zh`，其他语言优先用 `en`，缺失时用另一种。

## Risks / Trade-offs

- [GitHub 不可达或被限流] → 不弹、不记已读，下次启动重试；已读之后不再请求 GitHub。
- [正文格式偏离模板] → 解析不出主题就不弹；模板和写作规范已写进 `codexhost-release` Skill，发版时人工确认全文。
- [跨多个版本升级只看到最新一版] → 对话框提供完整更新说明的链接；以后如有需要再汇总多个版本。
- [Release 正文在发布后被修改] → 已读的用户不会再看到改动后的公告；手动入口读到的是最新正文。

## Migration

无数据迁移。旧版本没有已读文件，按“未读”处理。回滚到旧版本后，这个文件会被忽略。

# Proposal

## Why

用户升级 codexhost 后，看不到这一版新增了什么，只有主动打开设置里的“更新”页才能读到发布说明，而那里显示的是 GitHub 上最新版的说明，不一定是正在运行的版本。参考 Cindy 的做法，升级后首次打开时弹出一页按主题排版的“更新公告”，让用户一眼看到本版变化和贡献者。Release Notes 模板已改为“总结 + 主题 + 作者”的写法（`codexhost-release` Skill），公告页直接用它，不需要另写一份文案。

## What Changes

- Host 按**当前运行版本**读取对应的正式 GitHub Release，从正文中解析出中英文两份公告：一句话总结，以及若干主题（图标、标题、说明、贡献者）。同时返回发布日期和 Release 链接。
- Host 记录“已读公告版本”，Desktop 和 Web 共用这一份记录：在任意一端确认过，另一端就不再弹。
- Desktop（注入的 Renderer）和 Web 启动并连上 Host 后，如果当前版本有公告且尚未读过，就弹出“更新公告”对话框。用户点“我知道了”或按 `Esc` 关闭，关闭即记为已读；点遮罩不会关闭。
- 设置的“更新”页新增“查看本版公告”，随时可以再打开，打开它不改变已读记录。
- 读取失败、版本不是正式发布、正文里没有主题时，不弹窗、不影响启动。失败的情况不记为已读，下次启动再试。

## Decisions

- **内容来源用 GitHub Release 正文，不随安装包内置。** 发布后发现文案有误，在 GitHub 上修改即可生效，打包流程也不用改。代价是离线时不弹，下次联网启动时补弹。随包内置（方案 B）已放弃。
- **由 Host 解析 Markdown，界面只拿结构化数据。** 解析规则集中在一处，便于测试；Desktop 和 Web 用同一个对话框组件，结构化数据走 `shared-contracts` 定义的 schema。
- **只显示当前运行版本的公告，不汇总跳过的多个版本。** 跨多个版本升级的用户只看到最新这一版，完整历史可以从对话框里的链接去 GitHub Releases 查看。这样实现最简单，以后有需要再扩展。
- **全新安装也会弹**，与 Cindy 一致：没有已读记录就视为未读。这样也省掉了“首次运行不弹、先记录基线”的额外状态。
- **已读记录放在 Host 侧，不放在浏览器或 Renderer 的本地存储**，这样 Desktop 和 Web 两端一致，多个标签页也只会弹一次。

## Capabilities

### New Capabilities
- `release-announcement`：按当前运行版本获取并解析发布公告、记录已读版本，并在 Desktop 和 Web 中显示更新公告对话框。

### Modified Capabilities

## Impact

- `packages/update-manager`：按 Tag 读取正式 GitHub Release，解析公告。
- `packages/host-runtime`：新增公告读取和确认已读两个 RPC，持久化已读版本。
- `packages/shared-contracts`：公告数据 schema 和 RPC 名称；加入 Desktop、Web、Console 的 RPC 允许列表。
- `packages/renderer-extension`：公告对话框组件、启动时触发、设置“更新”页的入口；Web 设置复用同一份代码。
- `apps/web-ui`（`ui-codexhost`）：连上 Host 后触发公告。
- `packages/web-server`：如果 Web 的 Host RPC 需要经过它转发，则同步放行这两个 RPC。
- 发布流程：沿用已改好的 Release Notes 模板，不改发布工作流。

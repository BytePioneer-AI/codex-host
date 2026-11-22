# Spec Delta

## MODIFIED Requirements

### Requirement: 启动命令
安装包和 npm 包 SHALL 提供 `codexhost` 和 `codexhost web`。两者都 SHALL 确保 Host 和 Web 在后台运行，再分别打开默认桌面入口或浏览器，然后返回。`codexhost web` SHALL 输出“已在后台运行，可用 `codexhost stop` 停止”的提示。从 Finder 或开始菜单打开时 SHALL 与 `codexhost` 行为相同。新增 `codexhost app` MUST 直接打开自有桌面入口（无桌面壳时回落本机 Web）。`npm start` 和 `npm start web` MUST 保持现有的前台行为。

#### Scenario: 第一次运行 codexhost
- **WHEN** 没有运行中的服务，用户运行 `codexhost`
- **THEN** Host、Web 与默认桌面入口被拉起，Web 只监听本机

#### Scenario: 第一次运行 codexhost web
- **WHEN** 没有运行中的服务，用户运行 `codexhost web`
- **THEN** Host 和 Web 被拉起，浏览器打开本机页面并自动登录，不启动桌面界面

#### Scenario: Web 启动失败不影响官方 Codex Desktop 模式
- **WHEN** 用户以官方 Codex Desktop 模式运行 `codexhost`，Web 启动失败
- **THEN** 官方 Codex Desktop 照常打开，失败原因可通过 `codexhost status` 查看

#### Scenario: 没有安装 Codex Desktop 且存在自有桌面壳
- **WHEN** 这台电脑没有安装 Codex Desktop 但随包携带自有桌面壳，用户运行 `codexhost`
- **THEN** 直接启动后台服务并打开自有桌面壳窗口，不算启动失败

#### Scenario: 没有安装 Codex Desktop 且无自有桌面壳
- **WHEN** 这台电脑没有安装 Codex Desktop 且当前安装不携带自有桌面壳，用户运行 `codexhost`
- **THEN** 命令说明未安装 Codex Desktop，并改为打开 Web，不算启动失败

#### Scenario: 没有图形界面
- **WHEN** 用户通过 SSH 或在没有图形界面的环境运行 `codexhost` 或 `codexhost web`
- **THEN** 不打开浏览器或桌面窗口，输出本机登录链接

### Requirement: 停止
`codexhost stop` SHALL 不经确认关闭这台电脑上 codexhost 的全部进程：它拉起的自有桌面壳、GUI、Web、Host、远程服务、Broker 和 Console，并在结束后输出被中断的任务数。自有桌面壳、GUI 和 Web MUST 先于 Host 停止，避免重新拉起 Host。没有安装的组件 SHALL 跳过。它 MUST 不关闭用户自己打开的 Codex Desktop，MUST 不修改自启项和 Tailscale 配置。会话记录 MUST 保留，被中断的任务 MUST 不自动继续。

#### Scenario: 有任务在运行
- **WHEN** 本地 Host 上有 1 个任务在运行，用户运行 `codexhost stop`
- **THEN** 所有进程停止，输出 1 个运行中的任务被中断

#### Scenario: 没有服务在运行
- **WHEN** 没有运行中的服务，用户运行 `codexhost stop`
- **THEN** 命令成功，并说明没有运行中的服务

#### Scenario: 自有桌面壳或 GUI 由 codexhost 拉起
- **WHEN** 自有桌面壳或 GUI 由 `codexhost` 打开，用户运行 `codexhost stop`
- **THEN** 对应桌面壳、托盘与 GUI 窗口关闭，Host 和 Web 不会被重新拉起

#### Scenario: GUI 由用户自己打开
- **WHEN** Codex Desktop 不是由 codexhost 拉起的，用户运行 `codexhost stop`
- **THEN** Codex Desktop 保持打开

#### Scenario: 远程服务也在运行
- **WHEN** 其他电脑正通过 SSH 使用这台电脑，用户运行 `codexhost stop`
- **THEN** 远程服务停止，命令说明其他电脑重新连接时会恢复；重新连接只恢复远程服务，不启动本地 Web 和 Host

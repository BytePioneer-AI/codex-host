# web-background-service Specification

## Purpose
让安装包和 npm 用户用一条命令启动 Host 和 Web，并让它们脱离终端在后台持续运行，这样关掉终端、GUI 或浏览器后手机仍能连接。

## Requirements

### Requirement: 启动命令
安装包和 npm 包 SHALL 提供 `codexhost` 和 `codexhost web`。两者都 SHALL 确保 Host 和 Web 在后台运行，再分别打开 GUI 和浏览器，然后返回。`codexhost web` SHALL 输出“已在后台运行，可用 `codexhost stop` 停止”的提示。从 Finder 或开始菜单打开时 SHALL 与 `codexhost` 行为相同。`npm start` 和 `npm start web` MUST 保持现有的前台行为。

#### Scenario: 第一次运行 codexhost
- **WHEN** 没有运行中的服务，用户运行 `codexhost`
- **THEN** Host、Web 和 GUI 都被拉起，Web 只监听本机

#### Scenario: 第一次运行 codexhost web
- **WHEN** 没有运行中的服务，用户运行 `codexhost web`
- **THEN** Host 和 Web 被拉起，浏览器打开本机页面并自动登录，不启动 GUI

#### Scenario: Web 启动失败不影响 GUI
- **WHEN** 用户运行 `codexhost`，Web 启动失败
- **THEN** GUI 照常打开，失败原因可通过 `codexhost status` 查看

#### Scenario: 没有安装 Codex Desktop
- **WHEN** 这台电脑没有安装 Codex Desktop，用户运行 `codexhost`
- **THEN** 命令说明未安装 Codex Desktop，并改为打开 Web，不算启动失败

#### Scenario: 没有图形界面
- **WHEN** 用户通过 SSH 或在没有图形界面的环境运行 `codexhost web`
- **THEN** 不打开浏览器，输出本机登录链接

### Requirement: 后台运行与复用
Host 和 Web SHALL 脱离启动它们的终端和界面运行。重复运行或换一条命令时，SHALL 复用已运行的 Host 和 Web，只打开对应界面，不重启；只有 Host 在运行时 SHALL 补上 Web。同时启动 MUST 只产生一份服务，后到的命令等待并复用。

#### Scenario: 关闭界面
- **WHEN** 用户关闭终端、GUI 窗口或浏览器
- **THEN** Host 和 Web 继续运行，手机仍能连接

#### Scenario: 从 Web 切到 GUI
- **WHEN** 用户运行过 `codexhost web`，再运行 `codexhost`
- **THEN** 只打开 GUI，运行中的任务不中断

#### Scenario: GUI 已打开
- **WHEN** GUI 已由 codexhost 打开，用户再次运行 `codexhost`
- **THEN** 切到现有窗口，不重启

#### Scenario: 只有 Host 在运行
- **WHEN** Host 在运行而 Web 没有，用户运行任一启动命令
- **THEN** 拉起 Web 并打开对应界面，Host 不重启

#### Scenario: 同时启动
- **WHEN** 两个终端同时运行启动命令
- **THEN** 只启动一份服务，两条命令都成功

### Requirement: 监听地址与启动选项
发行版 Web SHALL 默认只监听 `127.0.0.1:4400`。`codexhost web` SHALL 接受 `--host`、`--port`、`--public-url` 和 `--trusted-proxy`，给出的选项 MUST 被保存并用于之后的启动，空值清除该选项。选项与运行中的 Web 不一致时 SHALL 只重启 Web。端口被占用时 SHALL 提示失败，MUST 不自动换端口，也 MUST 不结束占用端口的进程。

#### Scenario: 换端口后沿用
- **WHEN** 用户运行 `codexhost web --port 4500`，之后运行 `codexhost`
- **THEN** Web 继续使用 4500

#### Scenario: 端口被占用
- **WHEN** 4400 已被其他程序占用，用户运行 `codexhost web`
- **THEN** 命令说明端口被占用，并提示可用 `--port` 指定，其他程序不受影响

#### Scenario: 开发命令遇到后台 Web
- **WHEN** 后台 Web 占用 4400，用户运行 `npm start web`
- **THEN** 命令提示端口被占用，不结束后台 Web

### Requirement: 停止
`codexhost stop` SHALL 不经确认关闭这台电脑上 codexhost 的全部进程：它拉起的 GUI、Web、Host、远程服务、Broker 和 Console，并在结束后输出被中断的任务数。GUI 和 Web MUST 先于 Host 停止，避免重新拉起 Host。没有安装的组件 SHALL 跳过。它 MUST 不关闭用户自己打开的 Codex Desktop，MUST 不修改自启项和 Tailscale 配置。会话记录 MUST 保留，被中断的任务 MUST 不自动继续。

#### Scenario: 有任务在运行
- **WHEN** 本地 Host 上有 1 个任务在运行，用户运行 `codexhost stop`
- **THEN** 所有进程停止，输出 1 个运行中的任务被中断

#### Scenario: 没有服务在运行
- **WHEN** 没有运行中的服务，用户运行 `codexhost stop`
- **THEN** 命令成功，并说明没有运行中的服务

#### Scenario: GUI 由 codexhost 拉起
- **WHEN** GUI 由 `codexhost` 打开，用户运行 `codexhost stop`
- **THEN** GUI 窗口关闭，Host 和 Web 不会被重新拉起

#### Scenario: GUI 由用户自己打开
- **WHEN** Codex Desktop 不是由 codexhost 拉起的，用户运行 `codexhost stop`
- **THEN** Codex Desktop 保持打开

#### Scenario: 远程服务也在运行
- **WHEN** 其他电脑正通过 SSH 使用这台电脑，用户运行 `codexhost stop`
- **THEN** 远程服务停止，命令说明其他电脑重新连接时会恢复；重新连接只恢复远程服务，不启动本地 Web 和 Host

### Requirement: 状态
`codexhost status` SHALL 显示 Host 和 Web 是否运行及其版本、Web 的访问地址、最近一次 Web 启动失败的原因，以及自启项是否开启和有效。它 MUST 只读，MUST 不启动任何服务，输出 MUST 不包含 token。

#### Scenario: 服务在运行
- **WHEN** Host 和 Web 都在运行
- **THEN** 输出两者的状态、版本和不带 token 的访问地址

#### Scenario: 自启项失效
- **WHEN** 自启项指向的程序已不存在
- **THEN** 输出自启项失效，并说明重新运行 `codexhost` 可以修复

### Requirement: 崩溃恢复
Web 就绪后意外退出时 SHALL 带退避自动重启，持续运行一段时间后退避重置。启动阶段失败时 MUST 不反复重启，并 SHALL 保留失败原因。重启 Web MUST 不重启 Host，也 MUST 不影响运行中的任务，但 Web 终端会断开。Host 崩溃时 SHALL 由 Web 重新拉起，中断的任务 MUST 不自动继续。

#### Scenario: Web 崩溃
- **WHEN** 运行中的 Web 进程崩溃
- **THEN** Web 自动恢复，手机重新连接，Host 上的任务继续

#### Scenario: 启动失败
- **WHEN** Web 崩溃后因端口已被占用而无法启动
- **THEN** 不再重试，`codexhost status` 显示停止和失败原因

#### Scenario: Host 崩溃
- **WHEN** Host 进程崩溃
- **THEN** Web 重新拉起 Host，中断的任务保持中断，会话记录保留

### Requirement: 版本一致
`codexhost` 和 `codexhost web` 启动时，若运行中的 Host 或 Web 与当前程序的版本或安装位置不一致，SHALL 不判断是否有任务在运行，直接重启为当前程序，并输出被中断的任务数。同时装了安装包和 npm 版时 SHALL 以最后运行的为准并提示。`host ensure` 的语义 MUST 不变。

#### Scenario: npm update 后
- **WHEN** 用户运行 `npm update -g codexhost` 后再运行 `codexhost`
- **THEN** Host 和 Web 重启为新版本，并输出被中断的任务数

#### Scenario: 同时有两种安装
- **WHEN** 服务由 npm 版启动，用户运行安装包版的 `codexhost`
- **THEN** 服务重启为安装包版，并提示已切换

### Requirement: 登录后自动启动
登录后自动启动 SHALL 默认关闭，由用户在连接设备页或用命令开启，MUST 不在安装时注册。开启后，用户登录时 SHALL 只启动 Host 和 Web，不打开界面。开启状态下每次运行 `codexhost` SHALL 刷新自启项，使其指向当前程序。自启项 MUST 属于当前用户，MUST 不需要管理员权限。Linux 没有 systemd 用户服务时 SHALL 说明不支持。

#### Scenario: 开启后重启电脑
- **WHEN** 用户已开启自动启动，电脑重启并登录
- **THEN** Host 和 Web 在后台运行，不打开界面，中断的任务不自动重发

#### Scenario: 未开启时重启电脑
- **WHEN** 用户没有开启自动启动，电脑重启
- **THEN** 手机显示电脑离线，直到用户再次运行启动命令

#### Scenario: Node 路径变化
- **WHEN** npm 版用户切换了 Node 版本，然后运行 `codexhost`
- **THEN** 自启项更新为当前路径

#### Scenario: 不支持的 Linux
- **WHEN** Linux 上没有 systemd 用户服务
- **THEN** 开启失败并说明原因，其他功能不受影响

### Requirement: 发行内容
安装包和 npm 包 SHALL 包含运行 Web 所需的内容，用户 MUST 不需要源码；安装包版使用自带的 Node。只有 Office 预览组件 MAY 不随包发布。

#### Scenario: 全新安装
- **WHEN** 用户只安装了安装包或 npm 包，运行 `codexhost web`
- **THEN** Web 可以正常登录、发起会话和使用 Web 终端

### Requirement: Office 预览组件按需下载
发行版用户第一次预览需要 LibreOffice 转换的 Office 文档时，Web SHALL 在运行 Web 的电脑上自动从 npm 官方源下载当前平台的组件，页面 SHALL 提示正在下载，下载完成后自动显示预览。离开页面或关闭浏览器 MUST 不取消下载。版本和校验值 MUST 在发行时固定，校验失败按下载失败处理。下载 MUST 不上传用户文档，组件 MUST 保存在 Web 数据目录。下载失败时 SHALL 提示检查网络，MUST 不影响其他功能，下次预览时重试。

#### Scenario: 第一次预览
- **WHEN** 发行版用户第一次打开 DOCX，网络可用
- **THEN** 页面提示正在下载，下载完成后自动显示预览，之后的预览不再下载

#### Scenario: 下载时离开页面
- **WHEN** 下载进行中，用户切换到其他页面或关闭浏览器
- **THEN** 下载继续；用户之后再打开该文档时，下载已完成则直接显示预览，未完成则继续提示正在下载

#### Scenario: 用手机预览
- **WHEN** 用户在手机上第一次打开 DOCX
- **THEN** 组件下载到电脑上，不使用手机流量下载组件

#### Scenario: 没有网络
- **WHEN** 下载失败
- **THEN** 页面提示 Office 预览组件下载失败，请检查网络后重试，其他文件照常预览

#### Scenario: 已有组件
- **WHEN** 从源码运行，或组件已经随环境安装
- **THEN** 不下载，直接预览

### Requirement: 电脑端入口
连接设备页 SHALL 提供直连（局域网、Tailscale IP）开关和登录后自动启动开关。开关只在本机访问且 Web 以后台方式运行时可用；直连开关确认后 SHALL 重启 Web 并恢复页面。Codex 设置页 SHALL 提供打开连接设备页的入口，Web 没有运行时先拉起。

#### Scenario: 开启局域网访问
- **WHEN** 用户在本机打开直连并确认
- **THEN** Web 重启后监听所有 IPv4 网卡，页面恢复并显示局域网地址和二维码，运行中的任务不受影响

#### Scenario: 手机上打开连接设备页
- **WHEN** 手机打开连接设备页
- **THEN** 不显示这些开关

#### Scenario: 前台开发命令
- **WHEN** Web 由 `npm start web` 运行
- **THEN** 不显示直连和自启开关，监听地址由命令决定

#### Scenario: 从 GUI 打开
- **WHEN** 用户在 Codex 设置页点击打开连接设备页
- **THEN** 确保 Web 在运行，并在浏览器中打开该页面

### Requirement: 卸载
卸载 SHALL 停止 Host 和 Web，移除自启项，并提醒 Tailscale Serve 配置仍然保留。没有卸载程序的安装方式 SHALL 由文档给出等效步骤，并提供关闭自启项的命令。

#### Scenario: Windows 卸载
- **WHEN** 用户卸载 Windows 版
- **THEN** 卸载程序停止服务、移除自启项并显示 Serve 提醒

#### Scenario: macOS 或 npm 卸载
- **WHEN** 用户要移除 macOS 版或 npm 版
- **THEN** 文档说明先运行 `codexhost stop` 和关闭自启项的命令，并说明如何移除 Serve 配置

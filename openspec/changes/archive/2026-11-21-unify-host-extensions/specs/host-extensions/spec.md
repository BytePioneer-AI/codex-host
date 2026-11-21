# host-extensions Specification

## Purpose

定义由共享 `codexhost Host` 唯一托管的统一插件系统，支持纯前端、纯后台、跨端独立管理页与双端宿主注入等自由组合形态，使 Desktop 与 Web 作为平等渲染壳共享同一套安装、配置、数据与单实例后台进程。

## ADDED Requirements

### Requirement: Unified optional-entry extension manifest

系统 SHALL 接受统一的插件清单格式，其中后台入口、跨端独立管理页入口、Desktop 宿主注入入口与 Web 宿主注入入口均为可选字段，但每个有效插件 MUST 至少声明其中一项入口。系统 SHALL 保持对既有仅含 Desktop 入口的 v1 插件清单的兼容解析，且 MUST 在安装和加载时拒绝路径越界、非法扩展 ID 或声明不合法入口的插件包。

#### Scenario: Pure frontend widget without backend
- **WHEN** 开发者打包一个仅声明 Web 入口或仅声明 Desktop 入口（可仅含样式文件）且不含后台入口的插件
- **THEN** 系统接受安装并正常启用该插件，且不启动任何后台子进程

#### Scenario: Standalone cross-platform management page with shared backend
- **WHEN** 插件声明跨端独立管理页入口与后台入口，未声明任何宿主注入入口
- **THEN** 系统将其识别为双端可用插件，Desktop 与 Web 均可打开同一份独立管理页并与同一后台通信

#### Scenario: Dual-surface host injection with shared backend
- **WHEN** 插件同时声明 Desktop 注入入口、Web 注入入口与一份后台入口
- **THEN** Desktop 仅加载 Desktop 入口，Web 仅加载 Web 入口，两端共用同一份配置与同一个后台实例

#### Scenario: Manifest declares no runnable entry
- **WHEN** 插件清单既未声明后台入口，也未声明独立管理页、Desktop 或 Web 入口
- **THEN** 系统拒绝该插件包并返回明确校验错误

### Requirement: Single-owner Host persistence and single-instance backend lifecycle

共享 `codexhost Host` SHALL 作为插件安装目录、启用状态、持久化设置与插件数据目录的唯一拥有者。对于已启用且声明了后台入口的插件，只要共享 Host 处于运行状态，无论此时仅启动了 Desktop、仅启动了 Web、两端同时启动或两端界面均未打开，系统 MUST 仅运行唯一一个后台子进程实例。禁用、卸载、更新插件或关闭共享 Host 时，系统 MUST 终止并回收对应后台子进程。

#### Scenario: Both Desktop and Web connect to the same running backend
- **WHEN** 一个带后台的插件处于启用状态，且用户同时打开 Desktop 与 Web 访问该插件
- **THEN** 两端请求均路由到共享 Host 托管的同一个后台进程，读取与修改的是同一份设置和数据目录

#### Scenario: Neither frontend is open while Host runs
- **WHEN** 共享 Host 持续运行且带后台的插件已启用，但 Desktop 与 Web 界面均已关闭
- **THEN** 该插件的唯一后台进程保持受 Host 托管运行，不会因前端关闭被销毁或重复拉起

#### Scenario: Backend-only extension lifecycle
- **WHEN** 用户启用一个仅声明后台入口与声明式设置的插件
- **THEN** 共享 Host 启动其唯一后台实例；当用户禁用或卸载该插件时，共享 Host 停止该后台实例

### Requirement: Unified Host management RPCs, asset boundary, and Web proxy gate

共享 Host SHALL 通过统一控制与客户端通道提供插件列表、运行快照、统一市场目录、安装、更新、启停、卸载、紧急恢复、配置读写、资产读取及后台方法调用接口，并在状态或配置变化时推送变更通知。资产读取接口 MUST 仅返回当前有效安装代次下的声明前端入口与允许的静态媒体资源，MUST NOT 暴露后台代码文件或插件目录外文件。经 Web 服务访问上述管理、资产与后台调用接口时，MUST 遵循 Web 服务现有的登录鉴权与同源校验；开发模式下关闭鉴权时 MUST 拒绝管理写入与后台调用。远端 SSH 托管 Host MUST 拒绝本机插件管理接口。

#### Scenario: Web proxy serves extension assets from Host without owning disk state
- **WHEN** 已登录的浏览器通过 Web 服务请求已启用插件的静态脚本或样式资源
- **THEN** Web 服务验证登录身份与同源后从共享 Host 读取对应代次的受检资产并返回，不在 Web 服务本地维护独立插件安装目录或后台进程

#### Scenario: Asset endpoint blocks backend source and traversal
- **WHEN** 请求尝试通过资产接口读取后台入口脚本或包含父目录跳转的路径
- **THEN** 共享 Host 拒绝请求，不返回文件内容

#### Scenario: Unauthenticated or disabled-auth Web request
- **WHEN** 在开发模式关闭鉴权下或未通过登录鉴权的请求尝试安装、启停、修改配置或调用插件后台
- **THEN** Web 服务拒绝请求并保持现有插件状态不变

#### Scenario: Remote SSH managed Host rejects extension management
- **WHEN** 客户端向标记为远端 SSH 托管的 Host 发送插件管理请求
- **THEN** Host 返回方法不可用错误并保持远端状态不变

### Requirement: Cross-platform standalone management page contract

系统 SHALL 为声明了独立管理页入口的插件提供跨 Desktop 与 Web 一致的独立页面挂载契约。页面容器 MUST 向插件提供受控容器节点、当前语言与明暗主题（及变更订阅）、生命周期中止信号、不透明资产地址解析、持久化配置读写订阅、受限后台方法调用以及统一的语义主题变量。当页面关闭、插件被禁用或升级时，宿主 MUST 触发中止信号并执行插件返回的清理函数。加载与渲染独立管理页 MUST NOT 要求放宽宿主页面内容安全策略或暴露宿主私有内部对象。

#### Scenario: Same page bundle renders in Desktop and Web
- **WHEN** 用户分别在 Desktop 与 Web 的插件中心打开同一插件的独立管理页
- **THEN** 两端均加载插件包内同一份页面入口代码，成功渲染界面、加载声明图片资源并读写同一份插件设置与后台方法

#### Scenario: Closing or disabling aborts and cleans up the page
- **WHEN** 用户关闭独立管理页或禁用正在展示页面的插件
- **THEN** 宿主触发中止信号、调用页面清理函数并移除页面样式与节点

### Requirement: Single unified Plugins center across Desktop and Web

Desktop 与 Web 的设置界面 SHALL 各自呈现唯一的「插件」入口，直接展示共享 Host 上的统一已安装清单与统一市场目录，不再将界面拆分为独立的 Web 插件与 Desktop 扩展两个入口或切换视图。每张插件卡片 SHALL 清晰展示其适用范围与能力标记（如全端、Web、Desktop、独立页面、后台），用户可在任意一端完成安装、启停、声明式设置、打开独立管理页与卸载，且变更实时同步到另一端。

#### Scenario: Install once in Web and observe immediately in Desktop
- **WHEN** 用户在 Web 的「插件」中心安装并启用一个双端插件并修改其设置项
- **THEN** Desktop 的「插件」中心同步显示该插件为已启用状态且读取到相同的设置值，无需在 Desktop 再次安装

#### Scenario: Legacy DSH Web plugin recovery remains isolated
- **WHEN** Web 端安装了传统 DSH 客户端扩展并触发加载异常
- **THEN** 原有独立恢复入口仍可禁用该 DSH 扩展，不影响共享 Host 统一插件运行

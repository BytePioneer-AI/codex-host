# Spec Delta

## Purpose

定义 Thread 如何在 Codex 内置浏览器中打开本地 HTML 预览：服务范围与安全边界、文件变化后的自动刷新、预览的生命周期，以及环境不支持时的明确反馈。

## ADDED Requirements

### Requirement: Thread 可以在内置浏览器中打开本地预览
系统 SHALL 提供 `codexhost preview open <path>`，供 Host 拉起的任一 Harness 进程使用。Host SHALL 在 loopback 随机端口上只读服务目标文件所在目录，并在 Codex 内置浏览器的后台标签中打开该文件，挂在当前可见的本地任务下并切到前台。命令 SHALL 返回预览标识、URL 与打开方式。同一文件重复打开时 SHALL 复用已有预览并切到前台。

#### Scenario: 打开设计稿
- **WHEN** Thread 在工作目录内执行 `codexhost preview open .spec/mockups/index.html`
- **THEN** 内置浏览器 SHALL 显示该页面，页面中的相对路径资源 SHALL 可以加载
- **AND** 结果 SHALL 包含 `previewId`、`url` 与 `opened: "builtInBrowser"`

#### Scenario: 重复打开
- **WHEN** 同一文件已有打开的预览，再次执行 `preview open`
- **THEN** 系统 SHALL 切到已有预览，MUST NOT 新开第二个服务器或标签

### Requirement: 预览只服务调用方工作目录内的文件
预览服务器 SHALL 只响应读取请求，根目录为目标文件所在目录。目标文件 SHALL 位于调用方 Thread 的工作目录内；越出工作目录的路径、路径穿越和指向根目录之外的符号链接 SHALL 被拒绝。服务器 SHALL 只监听 loopback，MUST NOT 提供目录列表。

#### Scenario: 路径越界
- **WHEN** Thread 执行 `preview open ../../etc/hosts` 或请求中包含 `..`
- **THEN** 命令或请求 SHALL 以 `INVALID_ARGUMENT` 或 404 拒绝

#### Scenario: 符号链接越界
- **WHEN** 被服务目录中的符号链接指向根目录之外
- **THEN** 对该路径的请求 SHALL 返回 404

### Requirement: 文件变化后预览自动刷新
被服务目录中的文件新增、修改或删除后，已打开的预览页 SHALL 在 1 秒内自动刷新。刷新所需的脚本 SHALL 只注入预览服务器返回的 HTML 响应，MUST NOT 注入 Codex 聊天页。短时间内的连续变化 SHALL 合并为一次刷新。

#### Scenario: agent 修改设计稿
- **WHEN** agent 修改 `.spec/mockups/index.html` 或其引用的样式文件
- **THEN** 预览页 SHALL 在 1 秒内显示修改后的内容，无需用户操作

#### Scenario: 连续写入
- **WHEN** agent 在 300 毫秒内连续写入多个文件
- **THEN** 预览页 SHALL 只刷新一次

### Requirement: 预览有明确的生命周期
系统 SHALL 提供 `preview list`、`preview show <id>` 与 `preview close <id>`。用户关闭预览标签后，对应预览 SHALL 保留服务，`preview show` 可以重新打开。创建预览的 Thread 被归档或 Runtime 退出时，相关预览 SHALL 关闭并释放端口。每个 Runtime 同时打开的预览数 SHALL 有上限，超出时最久未使用的预览 SHALL 被关闭。

#### Scenario: 列出与关闭
- **WHEN** Thread 执行 `preview list` 后执行 `preview close <id>`
- **THEN** 列表 SHALL 包含预览标识、文件路径、URL 与所属 Thread
- **AND** 关闭后该 URL SHALL 不再可访问

#### Scenario: Thread 归档
- **WHEN** 创建预览的 Thread 被归档
- **THEN** 其全部预览 SHALL 关闭

### Requirement: 环境不支持时给出明确反馈
内置浏览器不可用、没有可见的本地任务，或 Thread 运行在受管远程 Host 上时，`preview open` MUST NOT 静默失败。本机可用时，系统 SHALL 改在系统默认浏览器打开并在结果中注明；受管远程 Host 上 SHALL 返回 `UNSUPPORTED` 与文件在该 Host 上的路径。

#### Scenario: 没有可见的本地任务
- **WHEN** Desktop 窗口未显示任何本地任务时执行 `preview open`
- **THEN** 系统 SHALL 在系统浏览器打开预览
- **AND** 结果 SHALL 为 `opened: "systemBrowser"` 并附原因

#### Scenario: 受管远程 Host
- **WHEN** 运行在 SSH 受管远程 Host 上的 Thread 执行 `preview open`
- **THEN** 命令 SHALL 以 `UNSUPPORTED` 失败，并返回文件在远程 Host 上的路径

# Spec Delta

## Purpose

独立 Web 右侧栏按 DSH Web 原样提供文件树、文档预览、终端和浏览器，并以 Web 已知的本地 Thread 及其工作目录作为这些能力的作用范围。

## ADDED Requirements

### Requirement: 右侧栏能力与 DSH Web 一致

系统 SHALL 在独立 Web 右侧栏提供 DSH Web 原有的文件树、文档预览、终端和浏览器标签页，其界面、格式支持、限额、错误提示与布局恢复 MUST 与 DSH Web 一致。系统 MUST NOT 为此新增 DSH Web 没有的设置项、开关或交互。

#### Scenario: 打开右侧栏
- **WHEN** 用户在本地 Thread 中展开右侧栏
- **THEN** 引导页列出文件、终端和浏览器入口，打开后的行为与 DSH Web 相同

#### Scenario: 从聊天打开文件
- **WHEN** 用户点击聊天中的本地文件链接
- **THEN** 右侧栏以 DSH Web 相同方式打开该文件预览并定位到链接中的行号

### Requirement: 能力作用于本地 Thread 的工作目录

文件树、文件读取和终端 MUST 以该 Thread 在 Host 上记录的工作目录为准，MUST NOT 采信浏览器提交的工作目录。无法确定本地工作目录的 Thread（未发送草稿、官方 Codex Thread、远程 Thread）MUST 显示不可用，且 MUST NOT 为此创建 Thread、Native Session 或提交 Turn。

#### Scenario: 本地 Thread
- **WHEN** 用户在已有本地工作目录的 Thread 中打开文件树或新建终端
- **THEN** 文件树根目录与终端起始目录均为该 Thread 的工作目录

#### Scenario: 草稿或非本地 Thread
- **WHEN** 用户在未发送草稿、官方 Codex Thread 或远程 Thread 中打开文件树或终端
- **THEN** 系统显示不可用，不产生 Thread、会话或进程

### Requirement: 访问受现有 Web 认证保护

右侧栏的所有文件、终端与转换请求 MUST 经过现有 Web 登录认证；未认证请求 MUST 被拒绝且不返回文件内容或终端输出。终端 MUST NOT 向 Harness 或模型发送输出。

#### Scenario: 未认证访问
- **WHEN** 未登录的请求读取文件或连接终端
- **THEN** 系统拒绝请求，不泄露内容

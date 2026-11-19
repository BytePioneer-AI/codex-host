# Spec Delta

## Purpose

让已经连接电脑的 Web 用户通过一次显式操作查看该电脑主屏当前显示的真实桌面，并能手动重新取图。该能力提供临时的现场确认，不承担持续投屏、远程输入或向 Harness 自动提交图片。

## ADDED Requirements

### Requirement: Explicit single desktop capture

系统 SHALL 仅在用户点击「桌面截图」或「重新截图」时采集一次运行当前 Web 服务的电脑主屏，并返回单张图片。系统 MUST NOT 定时采集、自动重试、将浏览器页面截图当作桌面截图，或根据 Thread 的执行目录选择 SSH 电脑。取图不创建 Thread、启动 Turn、暂停 Harness 或依赖 Codex Desktop。

#### Scenario: Capture while a Harness is running

- **WHEN** 用户在已有聊天中请求桌面截图
- **THEN** 系统返回当前连接电脑的主屏图片，已有草稿与 Harness 执行保持不变，且没有新增消息或 Turn

#### Scenario: No user capture request

- **WHEN** 用户打开聊天、刷新 Web、恢复网络或保留预览但没有点击取图
- **THEN** 系统不采集桌面，也不自动重放先前取图请求

### Requirement: Windows and macOS platform boundaries

系统 SHALL 提供 Windows、macOS 的真实桌面采集适配，并尊重操作系统的录屏权限与交互会话限制。主屏无法可靠定位、没有图形会话、权限被拒或环境不支持时 MUST 返回可理解的错误；不得静默改截另一块屏幕、窗口或虚拟页面。Linux 暂不支持截图，不得因此新增图形运行依赖或影响其他功能。系统不自动修改授权、解锁电脑或保证休眠电脑可用。

#### Scenario: Available primary display

- **WHEN** 用户在支持的 Windows 或 macOS 图形会话中请求取图，且该会话允许主屏采集
- **THEN** 系统返回该主屏实际显示的画面，不合并所有显示器

#### Scenario: Screen recording permission denied

- **WHEN** 操作系统拒绝或尚未授予屏幕采集权限
- **THEN** 系统说明需要在电脑端授权，不把有效图片编码或桌面背景图当作权限已满足的证明；macOS 主动请求系统授权，若申请仍未获准则尝试打开运行 Web 的 Mac 的录屏设置页并报告权限不足，不强制重复系统弹窗或替用户开启权限

#### Scenario: Permission granted during the explicit macOS request

- **WHEN** 用户点击取图，macOS 权限申请确认已获准
- **THEN** 系统继续本次单张截图，不打开权限设置页

#### Scenario: Permission settings opened without granting access

- **WHEN** macOS 权限申请仍未获准，系统已尝试打开设置页
- **THEN** 界面说明授权目标是运行 Web 的电脑而非手机，保留设置页未打开时的手动入口，授权后由用户手动重新截图；页面加载、重连或后台状态变化不会打开设置、轮询授权或自动重拍

#### Scenario: Linux computer

- **WHEN** 用户连接的电脑运行 Linux
- **THEN** 系统明确表明截图暂不支持，不执行采集或加载图形依赖，已有聊天和其他功能保持不变

### Requirement: Private authenticated image delivery

系统 SHALL 沿用当前 Web 的访问认证与同源校验，在通过校验后才执行采集。取图只返回本次生成的受限大小图片和拍摄时间，不接受浏览器指定的原生命令或输出文件路径。响应 MUST 禁止缓存；桌面截图不得自动附入草稿、发给 Agent、加入会话历史或广播给其他查看者。

#### Scenario: Unauthorized or cross-origin capture

- **WHEN** 未通过当前 Web 访问认证或同源检查的请求尝试取图
- **THEN** 系统拒绝请求，并且不执行桌面采集

#### Scenario: Sensitive desktop content

- **WHEN** 用户首次使用或查看该功能
- **THEN** 界面明确表明截图仅用于当前查看，并提示它可能包含其他应用、通知和敏感信息

### Requirement: Replaceable timestamped preview

系统 SHALL 在输入框附近临时展示截图与拍摄时间，支持点开放大、重新截图和关闭。重新截图成功后替换旧图，而非追加截图历史。获取中必须防止重复请求；失败保留旧图时 MUST 清楚标明本次获取失败及旧图时间，不得将旧图呈现为当前成功结果。

#### Scenario: Refresh succeeds

- **WHEN** 已有预览的用户重新截图成功
- **THEN** 单个预览被新图片与新拍摄时间替换，草稿不变

#### Scenario: Refresh fails

- **WHEN** 已有预览但重新截图失败
- **THEN** 系统显示原因，保留的旧图继续显示原拍摄时间并明确标识为旧截图，不自动重试

#### Scenario: Preview closed before capture finishes

- **WHEN** 用户关闭预览、切换聊天或离开页面后，旧请求才结束
- **THEN** 旧结果不能重新打开预览或落入另一条聊天，相关临时资源被释放

### Requirement: Bounded transient capture lifecycle

系统 SHALL 限制取图执行时间、图片字节与并发采集，不建立后台采集或无界请求队列。图片只供当前预览使用，不建立持久截图记录；原生采集必须临时落盘时 SHALL 在成功、失败、超时及可处理的取消路径清理文件。预览替换或关闭时必须释放浏览器图片资源。

#### Scenario: Capture times out or exceeds image limit

- **WHEN** 采集超过执行时限或结果超过图片大小限制
- **THEN** 系统终止或回收本次采集，报告失败，且不残留新的截图记录或无限等待请求

#### Scenario: Preview replaced or closed

- **WHEN** 用户替换或关闭已显示的截图
- **THEN** 系统释放原预览资源，不在服务器上建立可枚举的截图历史

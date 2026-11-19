# Spec Delta

## Purpose

让用户在通过 codexhost 打开的 Codex Desktop 中选装界面扩展，并在运行中启用、禁用或更新，无需重启 Desktop 或刷新窗口。扩展只通过宿主提供的受管原语访问 Desktop 和 Host 数据，失效时可以被完全移除。

## ADDED Requirements

### Requirement: 扩展的安装形态与发现

系统 SHALL 从 codexhost 数据目录下的 `extensions` 根目录发现 Desktop 界面扩展。每个扩展是一个子目录，包含 manifest、一个 Desktop 脚本和可选样式表，各文件 MUST 是位于该目录内的普通文件且不超过规定大小。发现过程 MUST NOT 执行扩展代码。无效的扩展 SHALL 被报告并跳过，不影响其他扩展；扩展根目录 MUST NOT 与 Harness 插件根目录共用。

#### Scenario: 有效扩展被发现

- **WHEN** 用户把一个 manifest 有效、文件齐全的扩展目录复制到扩展根目录
- **THEN** Console 列出该扩展的名称、版本和声明的槽位，状态为未启用，扩展代码没有运行

#### Scenario: 无效或越界的扩展

- **WHEN** 扩展的 manifest 无法解析、脚本是指向目录外的符号链接，或文件超过大小上限
- **THEN** Console 将该扩展标为无效并给出原因，其他扩展照常列出和运行

#### Scenario: Harness 插件目录不受影响

- **WHEN** 扩展根目录中存在扩展
- **THEN** Harness 插件的发现与诊断结果不变，不出现与扩展相关的无效插件报告

### Requirement: 宿主 API 版本兼容

manifest SHALL 声明扩展依赖的 Desktop 宿主 API 版本。声明了本机不支持的版本，或声明了本版本不支持的能力（例如扩展后端）时，系统 SHALL 将其标为不兼容并说明原因，MUST NOT 执行其代码或启用它。

#### Scenario: 需要更新的宿主版本

- **WHEN** 扩展声明的宿主 API 版本高于当前 codexhost 支持的版本
- **THEN** Console 显示"不兼容，需要更新 codexhost"，启用操作被拒绝

#### Scenario: 声明了后端

- **WHEN** 扩展的 manifest 声明了后端入口
- **THEN** 该扩展被标为不兼容，说明当前版本只支持 Desktop 界面部分

### Requirement: 启用选择的持久化

扩展的启用选择 SHALL 持久保存在扩展根目录中，独立于 Harness 插件的启用配置。新复制进来的扩展 SHALL 默认不启用。没有启用配置时 SHALL 视为不启用任何扩展。重启 Desktop 或共享 Host 后 SHALL 按已保存的选择恢复。

#### Scenario: 默认不启用

- **WHEN** 用户只复制了扩展目录，没有在 Console 中启用
- **THEN** 打开 Desktop 后该扩展不运行

#### Scenario: 重启后恢复

- **WHEN** 用户启用扩展后完全退出 codexhost，再重新打开 Desktop
- **THEN** 该扩展在 Desktop 就绪后自动生效

### Requirement: 运行中热应用

Desktop 正在运行时，启用、禁用以及已启用扩展的文件变化 SHALL 在数秒内应用到 Desktop 的主窗口，MUST NOT 重启 Codex Desktop 或刷新窗口。内容未变化的扩展 MUST NOT 被重复激活。更新扩展时 SHALL 先完全卸载旧版本，再激活新版本，任何时刻同一扩展只有一个实例在运行。

#### Scenario: 启用后立即出现

- **WHEN** Desktop 已打开，用户在 Console 中启用一个侧栏扩展
- **THEN** 无需刷新，扩展的界面即出现在侧栏中，现有 Composer 草稿和滚动位置不受影响

#### Scenario: 禁用后完全消失

- **WHEN** 用户禁用一个正在运行的扩展
- **THEN** 该扩展添加的元素、样式和对原生元素的标记全部移除，侧栏恢复到未安装时的外观

#### Scenario: 修改扩展文件

- **WHEN** 已启用扩展的脚本或样式文件被替换为新内容
- **THEN** 旧版本被卸载、新版本被激活，页面上不会同时存在新旧两套界面

#### Scenario: 文件内容未变

- **WHEN** 扩展目录收到不改变文件内容的变化（例如只更新了修改时间）
- **THEN** 扩展不被重新激活，其界面状态保持不变

### Requirement: 窗口重载与重新连接后的一致性

Desktop 窗口重载后，以及 Desktop Controller 重新连接已打开的窗口后，系统 SHALL 恢复为最新的启用集合，每个扩展只有一个实例。在 Controller 不可用期间被禁用的扩展，MUST NOT 在之后的窗口重载中继续运行。

#### Scenario: 窗口重载

- **WHEN** 两个扩展已启用，用户重载 Desktop 窗口
- **THEN** 两个扩展各自只激活一次，不残留重载前的实例或旧版本

#### Scenario: Controller 重新连接

- **WHEN** Desktop Controller 重启后重新连接仍在运行的 Desktop 窗口
- **THEN** 已在运行且内容未变的扩展保持原实例，不出现重复界面

### Requirement: 按扩展作用域的宿主 API

每个扩展激活时 SHALL 获得一个绑定其身份的 API，一个扩展 MUST NOT 以其他扩展的身份操作。v1 原语 SHALL 仅包括：侧栏行观察（行元素、所属 Host、Thread 或草稿标识）、本机 Host 的 Thread 树订阅、跳转到本机 Thread、Harness 名称与图标、受管的元素挂载与原生元素标记、卸载信号。API MUST NOT 提供通用 Host 请求、写操作、Composer 写入或 Desktop 私有对象。

#### Scenario: 观察侧栏行

- **WHEN** 扩展订阅侧栏行，随后 Desktop 重建了部分侧栏
- **THEN** 扩展收到变化后的行及其 Thread 标识；行属于远程 Host 时，所属 Host 不是本机

#### Scenario: 跳转到 Thread

- **WHEN** 扩展请求打开本机的一个 Thread
- **THEN** Desktop 通过其原生路由打开该 Thread；请求远程 Host 或未知 Thread 时返回错误，不改变当前页面

#### Scenario: 请求未开放的能力

- **WHEN** 扩展试图通过宿主 API 发送任意 Host 方法或修改 Thread
- **THEN** API 中没有这样的入口，Thread 和 Host 状态不变

### Requirement: 卸载时强制回收资源

扩展被禁用、更新、因冲突停用或失败时，系统 SHALL 先请求扩展自行清理并限定等待时间，然后无论扩展是否配合，都 SHALL 触发卸载信号，停止其侧栏观察和数据订阅，移除其挂载的元素、对原生元素的标记和样式表，并丢弃卸载后到达的回调与跳转请求。系统 MUST NOT 承诺撤销扩展绕过宿主 API 造成的副作用。

#### Scenario: 扩展没有实现清理

- **WHEN** 一个通过宿主原语挂载元素并隐藏原生行的扩展被禁用，而它没有提供清理逻辑
- **THEN** 它挂载的元素被移除，被隐藏的原生行重新显示

#### Scenario: 清理逻辑卡住

- **WHEN** 扩展的清理逻辑超时未完成
- **THEN** 系统照常完成强制回收，并在 Console 中记录清理超时

#### Scenario: 卸载后的迟到回调

- **WHEN** 扩展在被禁用前发起的数据订阅在禁用后才收到更新
- **THEN** 该更新不会被交给扩展，页面上不会重新出现该扩展的元素

### Requirement: 界面槽位互斥

扩展 SHALL 在 manifest 中声明它占用的界面槽位，并且只能从系统定义的槽位中选择。同一槽位在任一时刻 SHALL 只有一个扩展生效。启用配置中出现冲突时，排在前面的扩展生效，其余冲突扩展 SHALL 不激活，并显示为冲突，同时注明占用者。Console SHALL 拒绝启用与已启用扩展冲突的扩展。

#### Scenario: Console 中启用冲突扩展

- **WHEN** 委派树扩展已启用，用户再启用一个声明了同一侧栏槽位的角标扩展
- **THEN** Console 拒绝该操作并指出占用该槽位的扩展，已保存的选择不变

#### Scenario: 手工编辑造成冲突

- **WHEN** 启用配置被手工改成同时启用两个声明同一槽位的扩展
- **THEN** 排在前面的扩展运行，另一个显示为冲突且不运行

### Requirement: 故障隔离与状态报告

扩展在激活或回调中抛出的异常 SHALL 被隔离：该扩展被标为失败并强制回收，其他扩展和 codexhost 自身的界面功能 SHALL 继续工作。同一扩展在短时间内连续出错时，系统 SHALL 在当前窗口中停用它，但不修改已保存的选择。每个扩展的实际状态（运行中、未启用、无效、不兼容、冲突、失败）SHALL 在 Console 中可见。

#### Scenario: 激活时抛出异常

- **WHEN** 已启用扩展的激活代码抛出异常
- **THEN** 该扩展显示为失败并附带错误信息，其他扩展、Harness 选择器和侧栏 Agent 图标正常工作

#### Scenario: 回调持续出错

- **WHEN** 扩展的侧栏回调在短时间内反复抛出异常
- **THEN** 该扩展在当前窗口中被停用并显示为失败，重载窗口后按已保存选择重新尝试

### Requirement: Console 管理与兜底恢复

Console SHALL 列出全部已发现的扩展，显示其保存的选择和运行状态，并支持启用、禁用。Console SHALL 提供"禁用全部扩展并重载 Desktop 窗口"：该操作在 Desktop 界面已无法使用时也 SHALL 生效，执行后窗口中不运行任何扩展。Desktop 未运行时，Console 的修改 SHALL 被保存，并在下次 Desktop 就绪时生效。

#### Scenario: 扩展把侧栏弄坏

- **WHEN** 某个扩展导致 Desktop 侧栏无法操作，用户在 Console 中执行"禁用全部扩展并重载"
- **THEN** 所有扩展的选择变为禁用，Desktop 窗口重载，侧栏恢复原生外观

#### Scenario: Desktop 未运行

- **WHEN** Desktop 未打开时用户在 Console 中启用一个扩展
- **THEN** 选择被保存，状态显示为等待 Desktop；下次打开 Desktop 后扩展生效

### Requirement: 适用范围与执行边界

v1 扩展 SHALL 只在通过 codexhost 打开、且已建立界面控制的 Codex Desktop 主窗口中运行，不在 Web、其他 Desktop 窗口或未经 codexhost 启动的 Desktop 中运行。启用或运行扩展 MUST NOT 改变 Harness 执行、Thread 归属与持久化、置顶、归档或官方 Codex 流量，也 MUST NOT 启动额外进程。

#### Scenario: Web 不加载

- **WHEN** 用户启用了扩展后打开独立 Web
- **THEN** Web 不加载该扩展，Web 自身的界面扩展不受影响

#### Scenario: 扩展不改变 Thread 行为

- **WHEN** 委派树扩展把子 Thread 显示在父 Thread 下
- **THEN** 子 Thread 的执行、置顶和归档行为与禁用扩展时相同

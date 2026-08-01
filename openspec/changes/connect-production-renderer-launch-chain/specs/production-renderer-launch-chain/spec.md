## ADDED Requirements

### Requirement: 安装入口显示生产Agent控件

受支持Desktop build中，安装后的codexhost Launcher SHALL通过正式Desktop Controller安装Renderer Extension，并 SHALL显示只包含Codex与Pi的Composer Agent控件。生产行为 MUST复用`versioned-renderer-agent-routing`定义的Composer、transport、标题隔离和fail-closed语义。

#### Scenario: 用户点击安装后的App

- **WHEN**用户无参数启动已安装codexhost并且Desktop结构受支持
- **THEN**官方Codex Desktop MUST启动并在主Composer显示Codex与Pi Agent控件
- **AND**生产Renderer MUST NOT显示Claude Code或任何开发诊断控件

#### Scenario: 无参数入口初始选择Pi

- **WHEN**用户无参数启动已安装codexhost
- **THEN**Launcher MUST让生产Renderer把新Composer初始显示为Pi
- **AND**Host对未携带外部transport carrier的创建 MUST使用Codex作为安全fallback

#### Scenario: 用户选择Pi并提交

- **WHEN**用户在生产Agent控件选择Pi并提交新Thread
- **THEN**原生创建 MUST携带已验证的Pi transport carrier并由Pi Host路由处理
- **AND**页面状态 MUST显示该Composer为Pi且locked

#### Scenario: 用户切换Codex并提交

- **WHEN**初始Pi Composer在提交前切换为Codex
- **THEN**Adapter MUST恢复官方Model状态且Host MUST把未标记创建交给官方Codex
- **AND**可见Codex选择 MUST NOT被Launcher的初始Pi偏好路由到Pi

### Requirement: 生产Renderer编排归属Desktop Control

`desktop-control` SHALL拥有主进程Inspector连接、主Renderer选择、Title Policy、Draft Prewarm Policy、Renderer源码执行和reload恢复的单一Control Session Interface。生产Controller与Renderer Probe MUST调用该Interface，MUST NOT分别维护生产安装顺序。

#### Scenario: Probe安装Renderer

- **WHEN**受控Renderer Probe运行
- **THEN**它 MUST通过`desktop-control` Control Session安装生产Policy和Renderer Adapter
- **AND**Observer、报告和Claude开发配置 MAY继续由Probe Tool拥有

#### Scenario: 删除Tools目录

- **WHEN**从概念上删除`tools/renderer-binding`诊断实现
- **THEN**生产Launcher、Desktop Controller和Renderer安装 MUST仍然完整可构建和运行
- **AND**只有诊断Observer、报告与受控Gate能力消失

### Requirement: Renderer生产入口与Probe入口隔离

Renderer Extension MUST提供独立browser IIFE生产入口和Probe入口。生产入口 MUST固定启用Codex与Pi并自动安装当前版本Adapter；Probe入口 MAY在显式开发配置下增加Claude Code。库出口 MUST NOT作为发布可执行Renderer脚本。

#### Scenario: 构建公开Renderer Bundle

- **WHEN**发布系统构建Renderer Extension
- **THEN**生产IIFE MUST包含Agent Binding与当前版本Adapter安装调用
- **AND** MUST NOT读取Claude Code开发开关或安装Probe Observer

#### Scenario: 构建Probe Bundle

- **WHEN**开发者运行Renderer Probe构建
- **THEN**Probe IIFE MUST复用同一共享安装实现
- **AND**现有显式Claude开发Gate MUST保持可用

### Requirement: Launcher监督Desktop与Controller

Launcher MUST使用私有Node启动随包Desktop Controller，有界等待明确readiness，并同时监督Controller和本次Desktop。Controller未ready、异常退出或恢复失败时 MUST终止本次Desktop，MUST NOT静默留下Stock UI与默认Pi后端组合。

#### Scenario: Controller成功ready

- **WHEN**Controller完成Policy安装、Renderer注入和Adapter ready验证
- **THEN**它 MUST只向Launcher发送固定`ready`信号
- **AND**Launcher SHALL继续监督Desktop与Controller直到Desktop退出

#### Scenario: Controller安装失败

- **WHEN**Inspector不可用、Desktop结构不支持、Adapter unsupported或Controller超时
- **THEN**Launcher MUST终止本次受控Desktop和Controller
- **AND** MUST返回明确非零结果而不是继续Stock UI

#### Scenario: Desktop正常退出

- **WHEN**用户关闭本次Desktop
- **THEN**Launcher MUST有界终止Controller并清理本次进程
- **AND**不得留下Controller孤儿进程

### Requirement: 生产Inspector保持本地且临时

生产Launcher SHALL只为本次Desktop分配随机loopback Electron Inspector端口，MUST NOT启用Chromium remote debugging，MUST NOT使用固定Probe端口，也 MUST NOT把端口持久化或输出到发布诊断。

#### Scenario: 启动生产Desktop

- **WHEN**Launcher准备Renderer生产连接
- **THEN**Desktop参数 MUST包含`--inspect=127.0.0.1:<ephemeral-port>`
- **AND** MUST NOT包含`--remote-debugging-port`或固定9222/9223

#### Scenario: 非loopback Controller endpoint

- **WHEN**Controller收到非loopback Inspector endpoint
- **THEN**它 MUST在连接前拒绝并非零退出

### Requirement: Renderer reload恢复生产能力

Desktop Controller SHALL在Renderer reload或主Renderer webContents替换后重新确认Title Policy归属、安装Draft Prewarm Policy并执行生产Renderer IIFE。恢复过程中Pi MUST保持不可提交；恢复失败 MUST使受控Desktop fail closed。

#### Scenario: 主Renderer reload

- **WHEN**已ready Renderer的生产Binding在reload后消失
- **THEN**Controller MUST重新建立readiness、prewarm bridge和Codex/Pi控件
- **AND**恢复后Agent状态机 MUST继续符合现有版本路由规格

#### Scenario: 恢复后结构不支持

- **WHEN**reload后的Renderer无法唯一选择或Adapter返回unsupported
- **THEN**Controller MUST报告失败并退出
- **AND**Launcher MUST终止本次Desktop

### Requirement: 发布Payload包含真实生产闭包

公开Payload SHALL包含Pi-only Host Runtime、Desktop Controller Bundle和生产Renderer IIFE。Bundle审计 MUST拒绝Tools、Tests、Claude Code、诊断Observer和未审查运行依赖；平台封装 MUST安装Controller与Renderer并保持相对路径可移动。

#### Scenario: 构建发布Payload

- **WHEN**发布系统组装目标Payload
- **THEN**`app/desktop-controller.mjs`和`app/renderer-extension.js` MUST存在并通过各自闭包审计
- **AND**库入口`dist/index.js` MUST NOT被复制为生产Renderer脚本

#### Scenario: 安装路径包含空格

- **WHEN**App或MSI安装根包含空格
- **THEN**Launcher MUST从自身位置解析Controller和Renderer绝对路径
- **AND**Controller MUST读取并安装随包Renderer而不依赖源码仓库

### Requirement: 真实安装验收证明Renderer链

发布验收 MUST从实际安装布局启动Desktop，并通过生产Controller状态和真实Composer行为证明Agent UI与Pi路由，而不以文件存在或默认Agent环境变量代替。

#### Scenario: macOS App真实验收

- **WHEN**测试者启动生成的macOS App并在主Composer选择Pi发送首轮
- **THEN**页面 MUST显示Codex/Pi控件并锁定Pi
- **AND**同一Thread MUST显示真实Pi输出且不得进入官方Codex Agent Loop

#### Scenario: 只存在Renderer文件

- **WHEN**Payload包含Renderer文件但没有Controller执行证据
- **THEN**发布验收 MUST失败
- **AND**不得把App表述为功能完整安装产物

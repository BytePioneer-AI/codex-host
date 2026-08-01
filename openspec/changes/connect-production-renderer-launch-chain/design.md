## Context

现有版本锁定Renderer Agent路由已通过真实macOS Desktop Gate：`tools/renderer-binding/run.mjs`连接Electron主进程Inspector，安装Title Policy，reload主Renderer，确认metadata service归属，安装Draft Prewarm Policy，再执行Probe IIFE。Composer Agent、transport carrier、Host路由和Pi Session行为已经由主spec约束。

当前安装App只启动Desktop并设置Shim/Host环境。发布Payload复制`renderer-extension/dist/index.js`，但该文件只是ESM库出口；Launcher没有Inspector参数、Desktop Controller或Renderer消费者。`tools/renderer-binding`还同时拥有生产候选编排和诊断Observer，导致开发Gate通过而安装产品缺失Agent UI。

本变更必须保持现有Gate行为、隐私和fail-closed语义，不修改官方ASAR，不开放固定调试端口，不把Claude Code开发依赖带入公开组合，也不能在Controller失败时留下“Stock UI + 默认Pi后端”的不一致Desktop。

## Goals / Non-Goals

**Goals:**

- 安装后点击App可在当前白名单Desktop中显示Codex/Pi控件，并复用已验证的Agent路由实现。
- `desktop-control`拥有Renderer选择、Policy顺序、注入和重载恢复的深Module；生产Controller和Probe是两个调用方。
- Launcher拥有随机Inspector端口、Desktop与Controller生命周期、readiness和失败清理。
- 公开Payload包含自安装Renderer IIFE和Desktop Controller Bundle，不包含Tool/Probe/Claude依赖。
- 保持现有Probe报告、Observer、Claude开发Gate和Composer transport语义；生产组合中让可见Agent选择而不是Host fallback决定新Thread路由。

**Non-Goals:**

- 不修改Renderer Agent切换状态机、transport model、Title Policy语义、Pi Host路由或官方Codex行为；只把Launcher默认Agent接入Renderer初始状态，并把Host未标记fallback固定为Codex。
- 不支持未白名单Desktop结构、多窗口并发、修改ASAR、固定远程调试端口或外部网络监听。
- 不把诊断Observer、报告、Claude开发开关或真实ID/Prompt采集带入生产Controller。
- 不解决Windows Codex安装发现或声明未经真实Windows Gate的运行支持。

## Decisions

### 1. `desktop-control`提供一个深Renderer Control Session

新增Module以`installRendererControlSession(options)`作为主要Interface。调用方只提供loopback Inspector endpoint和一个自安装Renderer源码字符串；Module内部负责：

```text
等待Electron Inspector
→选择唯一populated primary webContents
→安装Title Policy
→reload Renderer
→等待metadata service归属并标记readiness
→安装Draft Prewarm Policy
→执行Renderer源码
→验证Codex/Pi与Adapter ready
→持续检测reload并恢复上述Renderer级状态
```

返回Session只暴露当前脱敏安装状态、固定Renderer evaluate（供Probe诊断Adapter使用）、Title Policy计数和`close()`。webContents选择、Electron module表达式、超时和顺序不再由调用方复制。

替代方案是让生产Controller直接复制Probe Runner。该方案会再次混合Observer、报告、开发开关和生产行为，因此拒绝。

### 2. 生产只启用随机loopback Electron Inspector

Launcher在`127.0.0.1:0`取得临时端口后释放，并向本次Desktop传入`--inspect=127.0.0.1:<port>`。生产注入不需要Chromium CDP，因此不传`--remote-debugging-port`。Controller只接受HTTP loopback endpoint；随机端口不写用户配置或发布文件。

Inspector在Desktop运行期间保持可用，以支持Renderer reload恢复。Controller是唯一预期客户端；端口只监听loopback。固定9222/9223继续只属于开发Probe。

### 3. Renderer生产入口与Probe入口分离

Renderer Extension提取共享`installRendererBinding(enabledAgents, defaultAgent)`实现。生产入口固定`DEFAULT_RENDERER_AGENTS`即Codex/Pi，并读取Controller同一条执行源码中注入的受控初始Agent；Probe入口可根据受控配置增加Claude Code，并继续安装同一Adapter。两个入口均构建为browser IIFE；`dist/index.js`继续作为库出口但不再进入Payload。

生产入口不安装Observer、不读取开发配置、不记录内容。旧Probe全局状态暂时保持兼容，避免改变Title Policy和现有Gate；命名清理不是本变更目标。

### 4. 独立Desktop Controller Bundle负责连接与恢复

`packages/desktop-control/src/release-main.ts`解析固定`--inspector-endpoint`、`--renderer`绝对文件与`--default-agent codex|pi`参数，读取生产Renderer IIFE，在同一条Renderer执行源码中注入受控初始Agent后创建Control Session，成功后只向stdout写一行`ready`。之后按固定间隔调用`ensureInstalled()`；Renderer reload或webContents替换时重新标记readiness、安装prewarm bridge并执行IIFE。

结构不支持、Adapter不是ready、Inspector断开或恢复失败均写受控stderr并非零退出。Controller不启动Desktop、不拥有Host/Pi语义，也不输出Prompt、DOM、Model或ID。

### 5. Launcher拥有双进程生命周期和fail-closed

Launcher安装布局新增Desktop Controller和Renderer路径。启动顺序：

```text
解析全部随包资源
→确认没有既有Desktop
→分配随机Inspector端口
→带Shim/Host环境和Inspector参数启动Desktop
→用私有Node启动Desktop Controller
→有界等待Controller stdout `ready`
→同时监督Desktop与Controller
```

Controller在ready前后失败时，Launcher终止本次Desktop并返回错误；Desktop退出时Launcher终止Controller。macOS复用`DesktopSession`跟踪LaunchServices创建的真实App进程树；Windows保持可编译并使用现有直接子进程路径，真实Job/安装行为由Windows Gate确认。

Launcher把`--agent`传给Controller作为可见Composer初始Agent，但传给Host的未标记fallback固定为Codex。Pi选择继续由既有`codexhost/pi-native` carrier显式路由；Codex选择保留官方Model并进入官方Codex。这样无参数入口仍初始显示Pi，切换Codex后不会被Host fallback错误送往Pi。

不允许Controller失败后继续Stock UI，因为Stock UI没有生产Agent选择，不能证明界面与后端路由一致。

### 6. Probe复用生产Module但保留诊断层

`tools/renderer-binding/run.mjs`继续拥有CLI、Desktop启动、Chromium CDP inventory、Observer、报告、Claude开关和清理。它改为调用`desktop-control`的Control Session完成Title/Prewarm/Renderer安装，并通过Session的固定诊断方法读取状态与计数。

`renderer-selection.mjs`及其测试迁入`desktop-control`；`renderer-observer.mjs`、`observed-host.mjs`和报告逻辑继续留在`tools/`。真实Probe必须在迁移前后产生相同schema与状态语义。

### 7. 发布Payload审计真实运行闭包

`desktop-control`拥有独立esbuild Release脚本，输出Node 24 ESM `desktop-controller.mjs`并用metafile拒绝Tool、Test、Claude和未审查依赖。Renderer发布复制生产IIFE。固定Payload增加Controller文件，平台App/MSI定义同步安装。

发布测试不仅检查文件存在，还检查Renderer生产Bundle包含安装调用且不含Claude开发配置，Controller Bundle包含Control Session且不含`/tools/`输入。

## Risks / Trade-offs

- [Inspector是高权限本地接口] → 随机端口、显式127.0.0.1、无Chromium CDP、Controller全生命周期监督；不记录端口。
- [端口释放到Desktop绑定之间存在竞态] → Controller有界等待；绑定失败导致Desktop/Controller整体失败，不尝试固定端口fallback。
- [Renderer reload期间短暂无控件] → Controller持续检测并按固定顺序恢复；恢复失败终止受控Desktop。
- [Probe迁移引入行为回归] → 先让Probe调用新Module并保持真实Gate/报告测试，再接Launcher。
- [Windows生命周期证据不足] → 保持Windows编译与Module测试，不在真实Windows Gate前宣称运行支持。
- [私有Desktop结构变化] → 复用现有白名单签名和fail-closed检查，不增加启发式fallback。

## Migration Plan

1. 增加Control Session及测试，把`renderer-selection`逻辑迁入`desktop-control`。
2. 将Probe Runner切换到Control Session，保持Observer和报告行为。
3. 拆分Renderer共享安装函数、生产入口与Probe入口。
4. 增加Desktop Controller Release入口、Bundle审计和Payload文件。
5. 扩展Launcher资源契约、Inspector参数和双进程监督。
6. 生成macOS App，在真实Desktop验证点击、Codex/Pi显示、Pi首轮和reload恢复。
7. 通过后更新安装包证据；Windows保持待真实宿主验证。

回滚时Launcher恢复不启动Inspector/Controller，Payload删除Controller和生产Renderer文件；Host、Shim和现有Probe仍可独立工作。

## Open Questions

- 当前macOS真实Gate可以关闭；Windows生产运行支持仍等待真实Windows宿主与安装发现完成。

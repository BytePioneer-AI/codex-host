# Windows 自动更新的进程交接

设置页提供 Windows npm 与安装器发行版的应用内更新入口，并保留手动更新链接。Host 负责核对最新稳定 Release、下载并验证安装器产物（npm 更新无需下载产物），随后在 `%LOCALAPPDATA%\codexhost\updates` 写入请求、状态和活动锁。Host 不启动 Updater：它运行在 Desktop 的 Shim/Host 进程链内，启动的子进程可能随 Shim Job 一起退出。

```text
Renderer 更新指令 → Host 准备请求与状态 → Launcher 启动 Updater
                                        → Updater 确认旧 Launcher 并等待
                                        → Launcher 关闭 Desktop 树后退出
                                        → Updater 安装、重启并确认新 Launcher
```

Launcher 持有 Desktop 生命周期，在看到指向自身的 `prepared` 请求后启动临时 `codexhost-updater.exe`，转交活动锁，并等待 Helper 确认 `waiting-for-exit`。Helper 在确认确切、仍存活的 Launcher 可执行文件与进程实例后才发布该状态。若 Helper 启动或就绪失败，请求变为 `failed`，Launcher 保持 Desktop 运行，不重复启动同一请求；用户可重新发起更新。

Helper 就绪后，Launcher 先按 PID 和启动时间记录 Desktop 根进程及后代。Windows 子进程不会因父进程退出而自动结束，因此 Launcher 终止根进程后，还会逐个按确切实例终止已确认归属的后代，并等待退出。后代归属必须有仍存活的父实例，且子进程不能早于父实例启动，避免把复用父 PID 的旧孤儿进程误杀。Launcher 随后停止 Desktop Controller，并扫描安装所用的 Desktop、Shim 和 Host 可执行文件路径，以发现快照之后生成的进程。只要这些进程仍存活，Launcher 就不退出，Helper 也不会覆盖安装文件。

若后代捕获无法完成——例如 Desktop 根进程在 Helper 就绪与捕获之间自行退出，或归属链不再可观察——Launcher 不会反复重试注定失败的捕获。此时它改用同一套安装所属可执行文件扫描，逐个按确切实例终止现存进程并确认全部退出，再完成交接；若 Helper 已不再等待，则不停止任何进程。残留进程无法在限时内清除时，更新失败并保持可重试。

Updater 等待旧 Launcher 时以 PID 和启动时间核对进程实例；Windows 进程枚举或检查失败不能当作“已退出”。只有旧实例确实退出后，Updater 才执行对应的精确版本 npm 安装或已校验 SHA-256 的静默安装器，随后重新启动 codexhost，并等待新 Launcher 发布运行时描述符。安装、重启或检查失败都写入 `failed`，不会自动提权。

AppX Desktop 不能假设可由 Launcher 的 Job 原子封闭。后代快照和最终可执行文件扫描是安全边界：扫描到残留进程会阻止更新完成；无法检查的进程或扫描之后的极端新建进程仍需通过真实升级与故障注入验证。

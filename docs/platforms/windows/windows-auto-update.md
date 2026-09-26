# Windows 自动更新的进程交接

设置页提供 Windows npm 与安装器发行版的应用内更新入口，并保留手动更新链接。Host 负责核对最新稳定 Release、下载并验证安装器产物（npm 更新无需下载产物），随后在 `%LOCALAPPDATA%\codexhost\updates` 写入请求、状态和活动锁。Host 不启动 Updater：它运行在 Desktop 的 Shim/Host 进程链内，启动的子进程可能随 Shim Job 一起退出。

```text
Renderer 更新指令 → Host 准备请求与状态 → Launcher 启动 Updater
                                        → Updater 确认旧 Launcher 并等待
                                        → Launcher 关闭 Desktop 树、发布清理凭据后退出
                                        → Updater 核验凭据、安装、重启并确认新 Launcher
```

Launcher 持有 Desktop 生命周期，在看到指向自身的 `prepared` 请求后启动临时 `codexhost-updater.exe`，转交活动锁，并等待 Helper 确认 `waiting-for-exit`。Helper 在确认确切、仍存活的 Launcher 可执行文件与进程实例后才发布该状态。Launcher 保留 Helper 的子进程句柄，关闭 Desktop 前及交接期间持续核对进程存活和当前请求。若 Helper 启动、就绪或后续存活检查失败，请求变为 `failed`；尚未开始关闭的 Desktop 保持运行，不重复启动同一请求，用户可重新发起更新。

Helper 就绪后，Launcher 先按 PID 和启动时间记录 Desktop 根进程及后代。Windows 子进程不会因父进程退出而自动结束，因此 Launcher 终止根进程后，还会逐个按确切实例终止已确认归属的后代，并等待退出。后代归属必须有仍存活的父实例，且子进程不能早于父实例启动，避免把复用父 PID 的旧孤儿进程误杀。Launcher 随后停止 Desktop Controller，并只读扫描 Desktop、Shim 和安装内捆绑的 Node 可执行文件路径，以发现快照之后生成的进程。npm 或 `--node` 使用的共享系统 Node 不属于被替换的安装文件，不参与全局退出检查；已确认属于 Desktop 的 Node 后代仍必须退出。

若后代捕获无法完成——例如 Desktop 根进程在 Helper 就绪与捕获之间自行退出，或归属链不再可观察——Launcher 立即中止更新，不反复捕获，也不按可执行文件路径清扫其他进程。终止已归属进程失败、最终扫描发现残留或检查失败同样中止更新。中止时先停止并回收 Helper，再记录 `failed`；取消未完成时 Launcher 保持存活，避免普通退出分支意外放行安装。仅路径相同不足以证明归属，其他 Node 任务或独立 Desktop 实例不会因此被强杀。

Windows 和 macOS 的 Launcher 每次启动 Helper 都生成新的随机交接令牌，通过 `--handoff-token` 传给 Helper。只有 Desktop 清理和最终进程检查都成功，且 Helper 仍活跃时，Launcher 才在本次请求目录创建并同步 `cleanup-complete-v1` 凭据，然后退出。凭据使用独占创建；旧令牌、已有文件或发布失败都会中止更新。该契约由 Updater 的 Rust 公共库提供，Launcher 和 Updater 使用同一格式；令牌用于关联本次交接，不用于防御同用户恶意进程。

Updater 等待旧 Launcher 时以 PID 和启动时间核对 Windows 进程实例；Windows 进程枚举或检查失败不能当作“已退出”。只有旧实例确实退出且本次清理凭据匹配后，Updater 才执行对应的精确版本 npm 安装或已校验 SHA-256 的静默安装器。Launcher 在清理完成前崩溃或被强制终止时，缺少有效凭据会阻止安装。Updater 随后重新启动 codexhost，并等待新 Launcher 发布运行时描述符。安装、重启或检查失败都写入 `failed`，不会自动提权。

进程快照在同一 Windows 进程句柄下读取映像路径和启动时间，最终扫描再次核对该快照路径。无法读取完整映像时，Toolhelp 的可执行文件名用于区分相关候选与无关受保护进程：同名且仍存活的候选会阻止更新，System、CSRSS 等无关进程不会使所有更新失败。

AppX Desktop 不能假设可由 Launcher 的 Job 原子封闭。后代快照和最终只读扫描仍不能排除扫描结束之后才创建的新进程；真实安装器升级及失败恢复需要独立 Windows 环境验证。

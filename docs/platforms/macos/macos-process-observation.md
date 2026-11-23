# macOS 进程观察与路径读取

## 目的与范围

shim 和 Host / Web 监管进程必须持续观察后代进程，以保留短命父进程、脱离进程组、
重新挂到 PID 1 等情况下的退出清理能力。减少资源消耗不应削弱身份检查，也不应推迟
发现由已知进程 fork 出的后代。

`crates/platform/src/macos_process_observation.rs` 为 `ObservedProcessTree` 提供
分阶段快照；`crates/platform/src/macos_process_events.rs` 决定 Host / Web 监管
何时需要重新扫描。两项优化仅在 macOS 启用，Linux / Windows 路径不变。

## 算法与不变量

1. 枚举当前有效 UID 的 PID，以 root 运行时枚举全机 PID；读取父 PID、进程组、
   启动时间。非 root 时其他用户进程的 BSDInfo 不可读，本来就不会进入账本。
2. 从根 PID、已知 PID、符合原进程组时间条件的成员出发，求可能相关进程的集合。
   这是保守的候选集合，不是最终归属判断；包含可能已重用的已知 PID，保证原算法
   仍有机会拒绝根身份变化、清除已退出后代。已退出的已知父 PID 仍可作为候选起点。
3. 只为候选进程读取可执行文件路径。候选路径读取失败时仍丢弃对应快照，不能让
   无法读取的中间父进程凭空提供一条新的归属链。
4. 将完整候选快照交给原 `observe_snapshots` 算法；完整返回值、错误、后代账本和
   根身份验证保持原规则。候选可以多选，但不能漏选。

不缓存路径：合法 `exec` 可以在 PID 和启动时间不变时改变可执行文件。
公共 `process_snapshot` / `process_snapshots`、Desktop 发现、启动时路径验证、
信号发送前的实例检查均保持原行为。shim 的扫描频率和终止超时不变。

## Host / Web 监管的扫描时机

Host 和 Web 监管循环每 100 ms 检查一次，通过 `SupervisedChild::retain_descendants`
刷新后代账本，但只在需要时全量扫描：

- 对账本中的每个进程实例注册 kqueue `EVFILT_PROC`（fork、exit、exec）。任一事件
  到达后，下一个 100 ms 节拍全量扫描；登记新成员后再补扫一次，覆盖扫描与登记之间
  发生的 fork。
- 没有事件时每 2 秒兜底扫描一次，覆盖不经 fork 进入根进程组等没有事件可报的变化。
- 发信号、终止和等待进程树退出前始终全量扫描。

逃逸后代对照实验：中间进程 `setsid` 后 fork 后代，存活 0–400 ms 后退出，再强杀整棵
树。按事件扫描与每个节拍全量扫描的清理命中率相同。2026-11 在 release 构建、全机约
750 个进程下，空闲时单个监管进程的 CPU 从约 1.3% 降到约 0.1%。

## 验证

`process_observation_tests.rs` 使用未优化的全量快照作为参照，比较完整返回快照、
错误和内部归属账本，覆盖路径读取失败、根身份变化、重新挂接和 PID 重用。
固定种子对照额外覆盖 2000 帧拓扑与读取失败组合，并断言无关路径不被读取。

相关测试命令：

```sh
cargo test --locked -p codexhost-platform -p codexhost-shim -p codexhost-launcher --features codexhost-shim/test-utils
```

这些测试包含真实进程的字节转发、信号转发、忽略终止信号后的升级清理、逃逸后代
清理、合法 exec 和 Host Runtime 所有权交接。对照快照测试不能替代真实生命周期测试。

## 性能测量口径

比较同一源码版本修改前后的 release shim，仅通过已安装 launcher 的 `--shim`
参数切换二进制；官方 Desktop 和 Host Runtime 保持相同版本。
等待启动阶段后，使用累计进程 CPU 时间差分统计 shim，不将原生 Renderer 或
Harness 工作量算作优化收益。CPU 100% 代表一个核，RSS 不等于独占物理内存。

2026-09-15，M5 Pro / macOS 26.4，两轮约 22 秒窗口：

| 轮次 | 修改前 shim CPU | 修改后 shim CPU |
| --- | ---: | ---: |
| 1 | 16.85% | 3.47% |
| 2 | 9.27% | 3.67% |

另一次修改后采样为 6.80%，说明调度和系统负载会影响绝对值；不能承诺固定百分比。
成对测量 CPU 降幅约 60%–79%，shim RSS 均约 7 MiB，主要收益是 CPU 而非内存。
这不是完整产品工作负载基准，也不是跨平台功能安全保证。

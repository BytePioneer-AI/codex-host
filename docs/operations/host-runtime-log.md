# Host Runtime 日志

Host Runtime 的 stderr 由 Codex Desktop 接管，Desktop 只保留最后一行，`npm start` 也会在就绪后脱离终端。因此 Runtime 把自己的诊断输出另存一份到文件，崩溃后仍有据可查。

- 位置：`<数据目录>/logs/host-runtime.log`，数据目录为 `CODEXHOST_DATA_DIR`，未设置时是 `~/.codexhost`。
- 始终开启，无需配置。单个文件上限 5 MiB，超过后轮转为 `host-runtime.log.1`，只保留一份旧文件。
- 每行带 UTC 时间和进程号，多个 Runtime 进程可以同时追加。

记录内容：

- Runtime 写到 stderr 的诊断（`codexhost Host Runtime: ...` 等）；
- 未捕获异常与未处理 Promise 拒绝的完整堆栈（`FATAL <来源>: ...`），记录后进程仍按原样退出，行为不变；
- Runtime 启动与退出码。

不记录会话内容、协议流量、运行时令牌或 Harness 子进程的输出。委派 CLI 等短生命周期子命令不写这个文件，它们按原契约把错误写到自己的 stderr。

写日志失败（目录不可写等）会被忽略，不影响 Runtime。提交 Issue 时可附上相关片段，附之前仍请检查其中的本机路径等信息。

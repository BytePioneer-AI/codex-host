# 委派子会话命名

通过 `codexhost delegate start` 创建的子 Thread 默认命名为“父会话名 · 子任务名”，适用于原生 Codex 和外部 Harness。名称在创建时写入；父会话后来改名、子会话续聊或幂等重试都不联动改名，用户仍可手动重命名已有子会话。

```sh
codexhost delegate start --harness example --task-name "协议审查" --task "完整任务说明" --parent-thread <parent>
```

`--task-name` 是独立的显示名称，去除首尾空白后不能为空，输入长度不超过 120 个 UTF-16 代码单元；不传时使用任务正文第一行并截断至 120 个代码单元。任务正文原样投递，不增加命名提示。

父会话优先使用已保存标题；原生 Codex 通过不含 turns 的元数据读取 `name`，缺失时使用 `preview`。标题不可读取或为空时使用 `Untitled Thread`，不因此阻断任务。标题中的连续空白压成空格；完整名称最多 200 个代码单元，父标题过长时截断父标题，保留子任务后缀，且不截断代理对。

原生 Codex 先通过 `thread/name/set` 保存名称，再开始任务；命名失败时删除新建的空 Thread，不投递任务。外部 Harness 使用既有的 Thread 映射存储，在 Session 创建前保存标题。

显示名称不参与任务执行去重；同一 `request-id` 重试仍返回原子会话及原名称。此规则不修改历史子会话，也不控制 Harness 在内部自行创建的原生子 Agent。

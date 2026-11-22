# 委派子会话命名

通过 `codexhost delegate start` 创建的子 Thread 命名为“子任务名”，不拼接父会话标题或首条消息预览，适用于原生 Codex 和外部 Harness。名称在创建时写入；父会话后来改名、子会话续聊或幂等重试都不联动改名，用户仍可手动重命名已有子会话。

```sh
codexhost delegate start --harness example --task-name "协议审查" --task "完整任务说明" --parent-thread <parent>
```

`--task-name` 是独立的显示名称，去除首尾空白后不能为空，输入长度不超过 120 个 UTF-16 代码单元；不传时使用任务正文第一行并截断至 120 个代码单元。任务正文原样投递，不增加命名提示。委派 Skill 提示调用方为新子会话提供简短的 `--task-name`。

标题中的连续空白压成空格，最多 120 个 UTF-16 代码单元，不截断代理对；未传 `--task-name` 时仍回退到任务正文第一行。父会话元数据只用于工作区继承与来源识别，不参与子会话命名。

原生 Codex 先通过 `thread/name/set` 保存名称，再开始任务；名称只用于展示，命名失败时保留默认标题，任务照常投递。外部 Harness 使用既有的 Thread 映射存储，在 Session 创建前保存标题。

显示名称不参与任务执行去重；同一 `request-id` 重试仍返回原子会话及原名称。此规则不修改历史子会话，也不控制 Harness 在内部自行创建的原生子 Agent。

`delegate`、`read` 和列表返回的 `title` 字段及 JSON / compact 结构不变，Desktop 与 Web 将标题作为普通字符串渲染，不按 `·` 拆分。历史 Thread 的新 watch 通知只在生成链接标签时缩短长后缀，不回写标题或 watch 记录，详见 [Thread watch](thread-watch.md#通知格式)。Web 通知卡片仍优先显示目录中的当前标题，因此历史会话在目录中存在时可以继续显示完整旧标题。

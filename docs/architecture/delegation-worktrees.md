# 委派 CLI 的独立 Git worktree

`delegate start --worktree <branch>` 在 CLI 所在机器创建分支和 Git worktree，将新路径作为该次委派的 `cwd`。这不是 Harness 原生隔离选项，也不改变 GUI、Web 或 Runtime 的默认委派行为。

```sh
codexhost delegate start --harness pi --task "检查协议边界" \
  --cwd /projects/app --worktree review/protocol --base HEAD
```

## 路径与基线

- 源 checkout 使用 `--cwd`；相对路径按 CLI 进程当前目录解析。省略时使用 CLI 当前目录，不读取父 Thread 或 Runtime 的 cwd。
- `--base <ref>` 仅与 `--worktree` 一起使用，默认是源 checkout 的当前 `HEAD`，包括 detached HEAD。先解析为提交 SHA，再从该提交创建分支；不会复制源目录的未提交修改，也不会推断远端默认分支或 fetch。
- 位置固定为主仓库同级的 `<仓库名>.worktrees/<安全分支名>`。分支名中的非 ASCII 字母、数字、`.`、`_`、`-` 字符替换成 `-`，Git 分支名本身保持原样。例如 `/projects/app.worktrees/review-protocol`，分支为 `review/protocol`。
- 从已有 linked worktree 或仓库子目录调用时，目录位置仍以主仓库为准，基线则取源 checkout。
- JSON 和 compact 输出保留原有字段，并新增 `worktree: {path, branch, base}`；`base` 为实际使用的提交 SHA。Runtime 控制接口只收到有效 cwd，不负责创建或清理 worktree。

## 校验与失败

CLI 不判断任务是否应该使用 worktree，不在正常响应中输出工作流建议。使用 `--worktree` 时，以下情况在启动委派前报错：

- 源 cwd 不是 Git working tree；源 checkout 正在 merge、rebase，或索引仍有冲突。
- 分支名非法、同名本地分支存在，或安全化后的目标目录存在（包括空目录、文件及符号链接）。不覆盖现有对象。
- `--base` 无法解析为提交（默认 HEAD 也必须可解析）。

目标目录通过排他创建预留。创建 Git 分支或 checkout 失败时，错误会报告可能遗留的 `details.worktree` 和 `worktreeRetained: true`；分支创建前失败会尝试移除本次预留的空目录，不删除已有目录或分支。

Runtime 请求失败时保留已创建的 worktree 和分支，并在错误中明确返回路径与元数据。请求失败或响应丢失不能证明子 Thread 未启动，因此 CLI 不删除可能正被使用的工作目录。

成功创建的 worktree 不自动合并或清理，不安装依赖。清理由调用方在确认没有活动会话后显式进行。对已存在分支或目录的重试仍报重名错误；`--request-id` 不使 worktree 创建变成可复用操作。

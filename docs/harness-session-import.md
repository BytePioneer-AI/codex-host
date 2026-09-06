# 本地 Harness 会话导入

## 当前范围

设置 → 会话导入可登记 **Pi 原生 v3 Session** 和 **DSH Modern Session**。导入只建立 Host Thread 与原生 Session 的映射，不复制 Transcript、不转换 Harness、不发送用户 Turn；打开后仍通过对应 Adapter 的 `open({ kind: "resume" })` 恢复历史并继续会话。

- 设置页始终使用本地 Host，即使 Composer 当前连接远程工作区。
- 可选 Harness 来自该 Host 已加载、同时提供发现和解析能力的 Adapter，不使用 Renderer 内置 Harness 名单。
- 目录表示“实现了导入接口”，不保证当前原生运行时可用。DSH Legacy、旧 Host、缺失插件或不可用存储会明确失败，不伪装成无候选。
- DSH 仍保留原先本机、codexhost 管理的 exact `dsh-v0.1.2-rc.1` Modern 限定。
- 本次没有增加远程扫描、CC direct/Broker 导入，也没有完成整个 Agent Picker 的动态插件化。

## Adapter 契约与职责

定义位于 `packages/harness-adapter/src/text-session.ts`：

```ts
interface HarnessSessionImportCapability {
  listCandidates(): Promise<HarnessResult<readonly HarnessSessionImportCandidate[]>>;
  resolveCandidate?(nativeSessionId: string): Promise<HarnessResult<HarnessSessionImportSource>>;
}

interface HarnessSessionImportSource {
  candidate: HarnessSessionImportCandidate;
  nativeRef: NativeSessionRef;
}
```

`resolveCandidate` 可选是为了兼容旧 discovery-only 插件；未实现它的 Adapter **不可导入**。这不是允许 Host 从 ID 拼接默认原生引用。

- `listCandidates`：只返回有界的 ID、标题、更新时间、cwd 和运行状态。不能夹带 locator、凭据、Transcript 或原生 RPC payload。
- `resolveCandidate`：只读地重新发现/验证选中的 ID，确认可恢复的项目和完整原生引用。会话消失返回 `sessionNotFound`，当前协议不支持返回 `unsupported`；不能信任上次列表的缓存元数据。
- `candidate.nativeSessionId`、`nativeRef.nativeSessionId` 和所属 Harness 必须相符。
- `running: true` 表示已知忙碌，Host 拒绝；`false` 表示可可靠确认空闲；`null` 表示无法可靠确认。未知不能降为 false。
- Adapter 关闭后不能启动新的发现；正在进行的本地扫描要取消并收尾。插件不得直接操作 Host 映射库。

对于已经接入 Desktop 的 Harness，以后增加这两个方法、验证原生 resume 并补齐 Adapter 测试即可复用本地 Host/RPC/导入页面；无需再创建专属导入器或 Renderer 开关。新的插件整体产品接入仍受 [Renderer 边界](harness-plugin-runtime.md) 约束。

## Host 与浏览器边界

公共严格 Schema 位于 `packages/shared-contracts/src/harness-session-import.ts`：

| 固定 RPC | 请求 | 响应 |
|---|---|---|
| `codexhost/harness/session-import/sources` | `{}` | `{ harnesses: [{ harnessId, name }] }` |
| `codexhost/harness/session-import/list` | `{ harnessId, query?, offset?, limit? }` | `{ candidates, total }` |
| `codexhost/harness/session-import/import` | `{ harnessId, nativeSessionId }` | `{ threadId }` |

列表默认每页 20 条；页面可选 20 / 50 / 100 条，显示总数和上一页/下一页。搜索按标题、会话 ID、项目路径进行不区分大小写的子串匹配，覆盖所有候选而非仅当前页；提交搜索或切换 Harness/每页数量后回到第一页。Host 先过滤已映射会话、搜索、按活动时间与稳定 ID 排序，再分页；`total` 是过滤后的总数。单次响应最多 1,000 条只是 wire page 保护，不限制存储总量或总候选数。

旧 `codexhost/deepseek/modern-session/list` / `import` 作为兼容别名保留在 Host，复用同一个 DSH importer 和通知去重集合；旧 list 仍返回 `{ candidates }`，不改变原 DSH 协议限定。新 Renderer 只使用公共 RPC。旧 Host 未实现公共入口时显示不可用，不改走未经验证的原生桥接。存储读取失败显示“无法读取本地会话”，不再误报“不支持导入”。

`HarnessSessionImporter` 负责：

1. 列表过滤同 Harness 已 ready 的普通 Thread 映射；Subagent 映射不冒充普通会话所有者。
2. 按 `(harnessId, nativeSessionId)` 合并重复请求，并优先复用已存在映射。
3. 调用 Adapter resolver，检查新鲜元数据和身份，再检查并发提交者是否已胜出。
4. 创建 provisional，提交完整 `nativeRef`，保留 `notLoaded` 状态；持久化失败清理 provisional，唯一性冲突复用胜出映射。
5. 返回 Host Thread ID。Renderer 导航失败不能回滚已提交的映射；保留项目路径、重试打开，重挂载和过期请求不能重复导航。

Host 不承诺在 resolver 与 resume 之间锁住外部客户端；当前没有跨进程 Session 所有权转移协议。

## Pi 原生规则

实现位于 `packages/adapters/pi/src/pi-session-import.ts`，规则核对自 Pi 官方 `sessions.md`、`session-format.md`、`environment-variables.md` 及 SessionManager 实现（本机验证版本 **0.85.0**）：

- 默认扫描 `~/.pi/agent/sessions/<encoded-cwd>/*.jsonl`，只展开一层项目目录。
- `PI_CODING_AGENT_DIR` 替换 agent 根目录；`PI_CODING_AGENT_SESSION_DIR` 优先指定平铺会话目录。原生客户端曾使用其他 `--session-dir` 时，需要让 Host 的 Session 目录环境与之匹配；页面不接收任意文件路径。
- 仅读取 v3 Session header 和 Entry 树；流式维护 Entry 的用户消息祖先标记，最后 Entry 所在分支必须具有用户消息。旧格式、损坏内容、断裂/重复 Entry、无用户分支或已消失项目跳过，不在导入时迁移原生文件。
- 标题优先使用最新 `session_info.name`，未命名时回退首条有文本的用户消息（兼容字符串和文本块，截取至标题契约上限），无文本才保留 null；更新时间使用消息活动时间，缺失时回退文件修改时间。项目和会话文件路径解析为真实路径。
- 原生引用必须包含 `locator: { sessionFile }`。Host 原样持久化，resume 使用该文件，并由已有 Pi 恢复路径核对原生 Session ID、cwd 和活动分支。
- Pi 没有可靠的跨进程运行标记，因此候选始终为 `running: null`。**导入前先在原生客户端关闭该会话**，避免两个客户端同时写入同一 JSONL。界面展示未知状态和提示，不声称安全独占。
- 扫描不启动 Pi 进程、不写文件、不跟随枚举到的文件/目录符号链接。读取前后检查设备、inode、大小、mtime 和 ctime；列表暂时跳过读取过程中仍在变化的会话，不阻塞其余候选，选中会话在解析时变化则拒绝本次导入。
- **没有固定的总大小、单文件大小、文件数、目录项数、Entry 数或总候选数上限。**首次发现仍需流式遍历原生 JSONL，以获得准确标题和活动分支；不是分页读取 Transcript，也不会把全部 Transcript 常驻内存。
- 每个 Adapter 实例缓存文件指纹和有效候选元数据，翻页、搜索、刷新时只重新解析新建或变化的文件，并移除已删除文件。缓存不包含消息正文，不跨实例持久化。
- 导入时重新验证选中的文件；其余新建/变化的文件只读 header 做 ID 歧义检查，不重读全部历史。权限或身份歧义仍明确失败；重复原生 Session ID 不会被静默选中其中一个。

这些检查服务于正确性、流式读取和可取消性，不是对恶意本机文件替换的安全沙箱。

## 验证

定向测试覆盖 Pi 目录规则、活动分支、坏文件、消失/歧义、取消、只读发现，以及超过旧 64 MiB/256 MiB、1,000 候选和 100,000 Entry 限制的有效数据、缓存失效和按选中项复查；Host locator 持久化与重启、跨 Harness 相同 ID、旧 DSH RPC、幂等/竞争/忙碌/失败清理、过滤后分页与跨页搜索；Renderer 动态来源、分页大小/边界、搜索旧响应失效、导入期间控件锁定、未知状态、导入去重和导航失败恢复。

还使用 Pi **0.85.0** 的真实 `SessionManager` 创建隔离临时会话，经公共 Host importer 登记，再用真实 `pi --mode rpc --session ...` 恢复历史并继续一轮，验证同一 Session ID 与同一 JSONL 文件。该检查使用回环地址上的模拟 Provider，不调用付费 Model 服务，也不读取/修改用户原有会话。

这不是 Codex Desktop 端到端验收，也不代表 Windows、远程或 DSH 真机已在本次验证。

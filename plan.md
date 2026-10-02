# CodexHost 常驻 Daemon 改造计划

## 目标

把当前 `feat/external-ui-api` 分支从“External UI API 跟随 Codex Desktop Host Runtime 生命周期”演进成“一个长期存活的 CodexHost daemon 被多个 UI 复用”。

最终目标：

```text
Obsidian ───────┐
Web UI ─────────┼──> codexhost daemon
Codex Desktop ──┘        │
                         ├── External/Harness Sessions
                         ├── DeepSeek Harness
                         ├── Claude Code / OpenCode / ...
                         └── Official Codex（第二步迁入）
```

---

## 第一步：独立 External/Harness Daemon

### 范围

本阶段只把 External/Harness Session Owner 从 Codex Desktop 生命周期中拆出来。

Daemon 负责：

- 唯一 `SharedThreadOwner`
- 唯一 external-only `AppServerHost`
- Harness Plugin Registry / Adapter 生命周期
- External Thread Mapping Store
- External UI WebSocket API
- Shared Thread 本地 socket
- `runtime.json` 发布与客户端发现
- 断开 UI 后继续执行 Harness 回合
- 多 UI 复用同一 External/Harness Session

Codex Desktop 暂时继续负责：

- Official Codex Runtime
- Native Codex Account
- Desktop 自己的 Official Codex Session
- Renderer / Desktop Controller

Desktop 通过现有 `SharedThreadBridge` 访问 daemon 所拥有的 External/Harness Thread。

### 实现项

1. 新增 `daemon-runtime.ts`
   - 建立 Mapping Store。
   - 建立单一 `SharedThreadOwner`。
   - 建立 external-only `AppServerHost`。
   - External UI WebSocket 的每个连接改为 `SharedThreadOwner.createSession()`，不再为每个 UI 创建独立 Host。
   - 建立 shared-thread socket，供 Codex Desktop Host 连接。
   - SIGINT / SIGTERM 时统一清理。

2. Host Runtime 增加内部入口：
   - `--codexhost-daemon`

3. 增加 daemon 单实例保护：
   - 复用私有数据目录。
   - daemon descriptor / PID 必须可验证。
   - stale descriptor 不阻止重启。

4. Desktop Host 改为 External/Harness 路由代理：
   - `SharedThreadBridge.delegateCreates = true`。
   - External Harness 的 `thread/*`、`turn/*`、`codexhost/thread/*` 请求交给 daemon。
   - `codexhost/harness/*` 也由 daemon 统一处理，避免 Desktop 再创建第二套 Harness Adapter。

5. 第一阶段启动策略：
   - 提供显式 daemon 启动入口，开发阶段可独立启动和验证。
   - Launcher 自动 ensure-daemon 可在本阶段后半加入；不依赖第二步。

### 验收

- 关闭 Obsidian/Web UI 后，正在运行的 DeepSeek Harness 回合不被取消。
- 同时打开两个 External UI，只存在一套 Harness Session Owner。
- Codex Desktop 与 External UI 能看到同一 External Thread。
- Codex Desktop 退出后 daemon 仍存活。
- DeepSeek Harness 不因 Desktop + Obsidian 同时使用而启动两份相同 Session。
- `@codexhost/client` 无需更换协议。

---

## 第二步：统一 Official Codex 到 Daemon

### 范围

在第一步稳定后，把 Official Codex Runtime 也迁入 daemon，Desktop 侧 Host Runtime/ Shim 缩成薄桥。

目标结构：

```text
Codex Desktop --stdio--> thin bridge ──┐
Obsidian ------------------------------┼──> codexhost daemon
Web UI --------------------------------┘        │
                                               ├── Official Codex
                                               └── External Harnesses
```

### 实现项

1. Desktop 首次 attach 时把真实 app-server invocation 参数交给 daemon。
2. daemon 根据 Desktop attach 参数 lazy 创建/更新 `OfficialRuntimeScope`。
3. Shim 不再 spawn 完整 Host Runtime，只做 stdio <-> daemon transport。
4. Launcher 负责登录会话级 daemon 的 ensure/start/upgrade。
5. 删除 Desktop-owned `LocalRuntimeLease` 的 Host Runtime 所有权语义，改成 daemon 单实例所有权。
6. 统一 Official/External Session、账号、更新与 shutdown 生命周期。

### 验收

- 本机长期只保留一个完整 CodexHost Host Runtime。
- Codex Desktop 启停不影响 daemon。
- Obsidian 可在 Codex Desktop 未启动时继续使用 Harness。
- Codex Desktop 启动后 Official Codex 与 Harness 都复用同一个 daemon。
- Desktop 原生行为和 app-server 参数保持兼容。

---

## 当前执行状态

- [x] 规划为两步
- [x] 第一步：独立 External/Harness Daemon
- [ ] 第二步：统一 Official Codex 到 Daemon

### 第一步已完成

- 新增 `--codexhost-daemon` 长驻入口。
- daemon 使用唯一 `SharedThreadOwner` 承载 External/Harness Session。
- External UI 与 shared-thread socket 均复用同一个 Owner。
- Mapping Store 锁作为跨进程单实例门禁。
- Desktop 检测到 daemon 后使用前端空 Store，不再争抢 Mapping Store。
- Desktop 的 External Thread 与 `codexhost/harness/*` 请求统一路由到 daemon。
- daemon 模式下 Desktop 不再加载第二套 Harness Plugin。
- 两个并发 External UI client 的真实进程冒烟通过。
- SIGTERM 后 `runtime.json`、shared socket、Mapping Store lock 均正常清理。
- Web 管理端已提供 daemon `status / start / stop / restart`。
- Web 总览页已增加 Daemon 状态与启动、停止、重启控制。
- 不做开机自启；daemon 由 CodexHost Web 管理端按需启动。

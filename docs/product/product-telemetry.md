# 零 ID 本地去重匿名统计（Product Telemetry）

`codexhost` 使用**零设备 ID、本地去重**的极轻量聚合计数了解官方发行版的活跃趋势、入口形态、版本兼容面、远程访问方式及官方 Harness 使用比例，仅用于指导兼容性维护与功能排期，**完全不涉及任何个人隐私**。

## 核心安全设计：为什么采用“去重全在本地、零 ID 离机”

传统遥测通常会为每台电脑生成一个持久 `installId` 或哈希账号标识发往服务端去重，这在技术上允许服务端将多次请求关联到同一设备（假名化追踪）。

`codexhost` 采用开源生态中最保守、最安全的**纯本地去重 + 零 ID 聚合计数**架构：

1. **零标识符离开本机**：不生成、不保存也不发送任何 `installId`、UUID、硬件指纹、设备序列号或账号哈希；服务端接口显式拒绝包含 `installId` / `deviceId` / `userId` 的请求，数据库（Cloudflare D1）中**没有设备表，只存聚合计数器**。
2. **去重逻辑完全在本地完成**：日活（DAU）、周活（WAU）、月活（MAU）、新增装机及次日 / 7 日留存的判重全部在用户本地文件 `$CODEXHOST_DATA_DIR/telemetry-v1.json` 中按 UTC 日历日期完成。本机只在周期首次活跃或当天首次出现新维度时，向 `POST https://ext-stats.chost.dev/v1/telemetry/heartbeat` 发送一个无状态布尔增量（正文 < 1 KiB，3 秒超时，失败静默忽略，不阻塞任何本地功能）。
3. **物理上不可关联单个用户**：服务端每次只对对应日期和维度的计数器 `+1`，无法把任意两条请求关联到同一台机器或同一个人。
4. **仅官方发行构建启用**：本地源码开发构建（`development`）与常见 CI 环境默认完全关闭（零出站请求）。

## 完整上报字段清单（仅限以下 9 项）

所有请求在客户端发出前和服务端接收时均经过严格白名单校验（Zod `.strict()`）：

| 字段 | 说明 | 是否含个人隐私 |
| --- | --- | --- |
| 周期活跃布尔标记 | 本地日期判重后按需发送 `dailyActive`、`weeklyActive`、`monthlyActive`、`newInstall`、`retainedD1`、`retainedD7`、`remoteAny`（纯 `true` 标记，**无任何 ID**） | 否 |
| `appVersion` | `codexhost` 版本号（如 `0.28.2`，每日最多计 1 次） | 否 |
| `codexDesktopVersion` | 宿主 Codex Desktop 版本号（仅 Desktop 模式下从本地启动诊断记录读取，用于兼容维护） | 否 |
| `os` / `arch` | 操作系统（`darwin` / `win32` / `linux`）与 CPU 架构（`arm64` / `x64` / `ia32` / `arm`） | 否 |
| `uiLanguage` | 粗粒度 2 位主语言码（`zh` / `en` / `ja` / `ko` / `de` / `fr` / `es` / `pt` / `ru` / `other`，不含地区后缀） | 否 |
| `surfaces` | 当天使用过的入口形态（`codex-desktop`、`web`、`web-desktop-shell`、`web-mobile`、`ssh-remote`、`cli`） | 否 |
| `remoteAccess` | 当天实际发生已认证远程连接的通道类别（`official-relay`、`self-hosted-relay`、`tailscale-serve`、`tailscale-funnel`、`tailscale-ip`、`lan`、`custom-proxy`、`remote-peer`）；**不扫描未使用的本地配置，不上报任何域名或地址** | 否 |
| `harnesses` | 当天发过消息的官方白名单 Harness ID；所有自定义或私有 Harness 统一折叠为 `custom` | 否 |
| `country` *(仅服务端)* | 仅在 `dailyActive: true` 时由 Cloudflare 边缘读取 2 位国家/地区码并累加计数；**绝不记录或存储客户端 IP 地址** | 否 |

## 绝不采集的内容

- 任何设备 ID、UUID、硬件序列号、MAC 地址、用户名或账号哈希；
- 任何第三方客户端认证或凭证文件；
- 对话正文、提示词、工具输出、代码或任何文件内容；
- 项目路径、文件名、Git 仓库地址、工作区名称或已安装的本地插件清单；
- 具体模型名称、Provider、Token 用量、API Key、访问令牌、Cookie、自建中转域名或客户端 IP 原文。

## 如何关闭或检查实发数据

### 一键通过环境变量关闭（零出站请求）

以下任一环境变量均会立即禁用全部统计上报：

```sh
# 方式 1：CodexHost 专属开关（支持 0 / false / off / no / none）
export CODEXHOST_TELEMETRY=0

# 方式 2：通用行业标准 Do Not Track
export DO_NOT_TRACK=1

# 方式 3：关闭或重定向统计端点
export CODEXHOST_TELEMETRY_URL=off
```

### 其他控制与透明审计方式

- **本地文件持久化关闭**：将 `$CODEXHOST_DATA_DIR/telemetry-v1.json` 中的 `"enabled"` 设为 `false`（或通过本地 Host RPC `codexhost/telemetry/set` 设为 `{ "enabled": false }`）。
- **自动关闭场景**：从源码本地运行的开发构建（`development`）及常见 CI 环境（`CI`、`GITHUB_ACTIONS`、`GITLAB_CI` 等）会自动关闭。
- **实时查看发出的完整 JSON**：设置 `CODEXHOST_TELEMETRY_DEBUG=1`，每次发送前会在 `stderr` 完整打印目标地址与 JSON 正文，方便逐字节审计。

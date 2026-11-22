# Design

## Context

电脑端中转（[`add-web-remote-relay-client`](../2026-11-06-add-web-remote-relay-client/design.md)）已在 `packages/web-server/src/remote-relay/` 实现注册、进程内 TLS 和状态页；证书文件位置约定为数据目录 `remote-relay/certificate.pem` 与 `certificate-key.pem`，由本 change 写入。Relay（[`add-remote-relay-server`](../2026-11-06-add-remote-relay-server/design.md)）对 ALPN 恰为 `acme-tls/1` 的连接放行，不受日额度约束。

`acme-client` 5.4.0 的相关行为（已对照源码核实）：

- **库内重试：** 429、5xx 和部分网络错误会在库内按 `Retry-After` 重试，默认最多 5 次，次数由 `acme.axios.defaults.acmeSettings.retryMaxAttempts` 控制。
- **错误形态：** 错误响应最后被转成普通 `Error`，只剩 `detail` 文字，状态码、problem 类型和 `Retry-After` 都丢了。`badNonce` 由库单独重试，不受上面那个设置影响。
- **超时：** HTTP 请求没有超时（axios 默认 `timeout: 0`）。
- **状态等待：** `waitForValidStatus` 对 `ready` 和 `valid` 都返回，不代表证书已签发。
- **账户：** `createAccount` 找到已有账户后会接着调用 `updateAccount`，把同样的参数作为账户更新发出；参数里只有 `onlyReturnExisting` 时会去掉它，改发 POST-as-GET。
- **挑战证书：** `crypto.createAlpnCertificate(authz, keyAuthorization, key?)` 返回 `[key, cert]`。不传 key 时生成 RSA 密钥。
- **代理：** 依赖的 axios 1.21 会读取 `HTTPS_PROXY` / `NO_PROXY`，对 `https://` 目标用 CONNECT 隧道。

Let's Encrypt 相关约束：

- **验证失败：** 每个账户、每个名字每小时最多 5 次验证失败。
- **暂停：** 连续失败 1152 次后，这个账户和名字的组合会被暂停（zombie client 机制）。验证成功后重置计数。
- **续期豁免：** 同一组名字的续期不占“新订单”和“同注册域名新证书”这两项限额。
- **验证地点：** 生产环境目前从 5 个地点验证，staging 已是 7 个，同一个挑战会被连接多次。

## Decisions

### 模块

- `remote-relay/acme.ts` 完成一轮签发：
  1. 用账户私钥调用 `createAccount({ onlyReturnExisting: true })` 查找已有账户；证书机构返回 `urn:ietf:params:acme:error:accountDoesNotExist` 时，再调用 `createAccount({ termsOfServiceAgreed: true })` 创建。不提供邮箱，也不保存账户 URL。不对已有账户直接调用带 `termsOfServiceAgreed` 的 `createAccount`：库在这种情况下会附带一次非 POST-as-GET 的账户更新请求，服务器可以拒绝（Pebble 就会拒绝）。
  2. 下单。
  3. 读取 authorization，跳过已经 `valid` 的。对仍为 `pending` 的，用临时 P-256 私钥生成挑战证书，交给 TLS 入口，然后提交挑战。
  4. 轮询这些 authorization，直到全部 `valid` 或出现 `invalid`；出现 `invalid` 时按其 challenge 的 `error` 分类后结束本轮。
  5. 用 `certificate-key.pem` 生成 CSR 并 finalize，轮询订单直到 `valid` 或 `invalid`；`invalid` 时按订单的 `error` 分类后结束本轮。
  6. 下载证书。

  只用 `acme-client` 的单次请求接口（`createAccount`、`createOrder`、`getAuthorizations`、`completeChallenge`、`getOrder`、`finalizeOrder`、`getCertificate`），不用 `auto()` 和 `waitForValidStatus`。后者内部自带重试，绕过 `Retry-After`，也无法在等待中作废。轮询由本模块自己做：间隔取响应的 `Retry-After`，没有时为 2 秒；每次请求前确认本轮仍有效。
- `remote-relay/certificates.ts` 负责调度、失败记录、文件校验与替换，以及状态。纯函数 `nextAction(now, certificate, record)` 决定是立即签发，还是等到某个时间，单独测试。
- `RemoteRelay` 在 `registered(hostname)` 时启动证书管理，在 `connecting`、`stopped` 和 `close()` 时停止。
- **库的设置：** 在 `acme.axios` 上设置 `retryMaxAttempts = 0` 和 `timeout = 30_000`，由证书管理统一安排重试。再加一对拦截器：请求拦截器给每个请求标上发出时所属的轮次，响应拦截器把错误响应的状态码、problem 类型、`detail` 和 `Retry-After` 写入该请求所属的轮次，2xx 响应清除它。一轮内的请求是顺序的，所以失败时留下的就是导致失败的那个响应；库自行重试成功的 `badNonce` 不记录。作废的轮次对象不再被读取，迟到的旧响应写进去也不影响新轮次。
- **一轮的生命周期：** 每轮有编号和 10 分钟总期限。停止或超时就作废这一轮。每个异步步骤返回后，先确认这一轮仍然有效，再发下一个请求或写文件。撤下挑战证书时只撤本轮设置的那一份。

### 何时签发

- **证书可用的条件：** 主机名匹配（`X509Certificate.checkHost`，不区分大小写）、`notBefore ≤ 现在 < notAfter`、与 `certificate-key.pem` 匹配，并且能构造 TLS 上下文。
- 启动时加载、安装新证书、每次检查都用这同一条标准。证书变得不可用时（例如到期），立即从 TLS 入口撤下。
- 证书不可用时立即签发。可用时，到 `notBefore + (notAfter − notBefore) × 2/3` 签发。
- **检查时机：** 注册成功时检查一次，注册保持期间每小时检查一次。休眠醒来后控制连接会重新注册，注册就会触发检查，不需要另外检测唤醒。

### 失败与重试

失败记录 `remote-relay/certificate-state.json` 的结构是 `{ hostname, directory, failures, validationFailures, retryAt, retryAfter?, paused?, detail? }`，用 `DataDir.writeJson` 原子写入。`hostname` 或 `directory` 与当前不同的记录视为不存在，所以更换身份密钥或证书机构地址后从零开始。

- **每轮开始前先按失败写入记录：** `failures + 1`，`retryAt` 设为对应的退避时间。签发成功后删除整个文件。这样中途断线、进程退出或被替换的轮次都自然计入退避，不需要单独处理“结果未知”。
- **退避间隔：** 基准依次为 10 分钟、1 小时、6 小时，之后每 24 小时。每次在基准上再加 0–10% 的随机时间，所以抖动只会推迟，不会提前；末档实际为 24–26.4 小时。
- **服务端要求的等待：** 本轮的错误响应带 `Retry-After` 时，把它保存为 `retryAfter`。`retryAt` 取退避时间和 `retryAfter` 中较晚的一个。
- **跨进程：** 只有当前注册的进程写记录。Relay 替换注册时不等旧进程停止，同一数据目录上的两个 Web 进程可能在旧进程收到 4409 之前短暂重叠。写入时 `retryAt` 和 `retryAfter` 取文件中已有值与本轮值的较晚者，所以等待时间不会被覆盖短。仍可能丢失的只是一次 `failures` 计数，最坏结果是提前一档重试一次；不为此加文件锁。
- **失败分类：** 只看结构化字段，不解析 `detail` 文字。

| 失败 | 判断依据 | 处理 |
| --- | --- | --- |
| CAA 拒绝 | 挑战、订单或 finalize 响应的 problem 类型为 `urn:ietf:params:acme:error:caa` | 暂停 |
| 验证失败 | authorization 进入终态 `invalid`，且不是 CAA | `validationFailures + 1`，到 2 时暂停 |
| 其他 | 网络错误、超时、其他错误响应 | 只按退避 |

- **记录的清除：**
  - authorization 验证成功时，`validationFailures` 归零。
  - 用户重新打开中转开关时，清除 `failures`、`validationFailures` 和 `paused`，`retryAt` 改为 `retryAfter`（如果有）。
  - Web 重启只清除 `paused`。
  - 重新注册不改动记录。
- **失败说明：** `detail` 记录证书机构返回的说明。没有收到错误响应时（网络错误或超时）不记录，界面按语言显示“无法连接证书机构”。

### 文件

- **私钥：** 账户私钥 `remote-relay/acme-account.pem`，证书私钥 `remote-relay/certificate-key.pem`，都是 ECDSA P-256 PKCS#8。第一次需要时用排他方式（`wx`）创建，权限 0600。另一个进程已经创建时，读取已有文件，不覆盖。这与 `identity.ts` 的做法相同。
- **新证书的安装：** 先确认新证书可用，标准同上。然后用 0600 权限写临时文件，再 `rename` 到 `certificate.pem`，最后替换 TLS 入口的上下文。任何一步失败都保留旧证书。
- **证书文件的重叠写入：** 上述重叠期间两个进程可能都写证书。它们写入的是同一主机名、同一私钥的证书，原子替换保证文件完整，最后谁写入都可以用。
- 更换证书机构地址后，账户私钥沿用，会在新地址下创建新账户。

### TLS 入口

- **证书由外部设置：** `RelayTls` 不再自己读文件。证书管理通过 `useCertificate(context)` 和 `clear()` 设置正式证书，通过 `setChallenge(hostname, cert, key)` 和 `clearChallenge()` 设置挑战证书。
- **先读 ClientHello 再分流：** 10 秒期限从 stream 到达时开始，读 ClientHello 和握手共用这一个期限。
  - ALPN 恰为 `["acme-tls/1"]` 时：有挑战证书，且 SNI 与挑战主机名相同（不区分大小写），就用挑战证书完成握手，ALPN 只给 `acme-tls/1`，最低 TLS 1.2，握手后结束连接。否则关闭 stream。挑战证书一直保留到本轮结束，因为证书机构会从多个地点、多次连接。
  - 其他连接：有正式证书时按现有流程交给 HTTP 服务，否则关闭 stream。
- **复用 ClientHello 解析：** 从 `@codexhost/remote-relay` 复用。新增导出路径 `./client-hello`，`readClientHello` 的参数类型从 `net.Socket` 放宽为 `stream.Duplex`，其他不变。它自带的 10 秒计时与 Web 的共用期限同时开始，期限到时 Web 销毁 stream，读取随之失败，所以不会额外延长。Relay 的调用方不受影响。

### 代理

- 证书机构请求直接使用 axios 自带的 `HTTPS_PROXY` 支持，不另写代理代码。在依赖锁定后，用本机测试 HTTP 代理验证它确实使用 CONNECT。

### 状态

`WebRelayState` 的 `connected` 和 `missing-certificate` 增加 `certificate` 字段：

```ts
certificate: {
  expiresAt?: string;   // 当前可用证书的到期时间
  issuing: boolean;     // 正在签发
  failure?: {
    detail?: string;    // 证书机构的说明；没有时界面显示“无法连接证书机构”
    retryAt: string;    // 下次自动尝试的时间
    paused: boolean;    // 已暂停，需要用户修复后重新打开中转
  };
}
```

连接设备页按“手机能不能访问”显示，证书只是实现细节：

- **准备中：** 连接中，或已注册、首次申请证书还没有失败。页面每 2 秒自动刷新，直到状态稳定。
- **已开启：** 已连接，附地址。证书有效期和后台续期不显示；续期失败也不显示，旧证书仍然可用。
- **暂时无法使用：** 没有可用证书，并且申请失败、等待重试，附自动重试时间。
- **需要处理：** 申请已暂停（连续验证失败或 CAA 拒绝），附证书机构的说明（没有时显示无法连接证书机构），提示修复后关闭再打开中转。已连接时暂停也显示。
- **已停止：** 被替换、签名被拒或版本不支持，附原因。

`certificate` 字段保持完整，供界面判断和排查；界面不直接展示 `expiresAt` 和 `issuing`。

### 测试

- **单元测试：** `nextAction`、退避和抖动范围、失败分类、记录的清除规则。429、超时、`Retry-After` 和重启后的等待，用本地模拟响应和可控时钟测试，不依赖 Pebble。
- **Pebble 集成测试：** 放在单独的测试文件里，用单独的命令运行，不进默认测试集。环境变量 `CODEXHOST_TEST_PEBBLE_DIR` 指向放有 `pebble` 和 `pebble-challtestsrv` 的目录，缺少时测试失败，不会静默跳过。配置如下：

| 项目 | 配置 |
| --- | --- |
| DNS | Pebble 用 `-dnsserver` 指向 challtestsrv。challtestsrv 只提供 DNS：A 记录返回 127.0.0.1，不返回 AAAA，关闭它自己的 HTTP、HTTPS、TLS-ALPN 挑战监听 |
| 验证端口 | Pebble 配置的 `tlsPort` 设为进程内 Relay 的手机入口端口 |
| 验证行为 | `PEBBLE_VA_NOSLEEP=1`，`PEBBLE_VA_ALWAYS_VALID=0` |
| 授权复用 | 分别用 `PEBBLE_AUTHZREUSE=0` 和 `100` 跑两遍，覆盖两条路径 |
| 信任 | ACME 客户端信任 Pebble API 的测试 CA（`pebble.minica.pem`）。模拟手机信任 Pebble 每次启动生成的签发根，从 management API 的 `/roots/0` 获取 |

## Risks / Trade-offs

- [下单被拒等错误没有专门处理，会一直按退避重试] → 退避到每 24 小时一次后，对证书机构只是每天一个请求；状态页显示证书机构的原文说明，用户能自己判断。
- [不实现 ARI，证书机构无法提前调整续期时间] → 证书机构吊销证书或要求提前续期时，要等到 2/3 有效期才会续期。Let's Encrypt 认可没有 ARI 的客户端按 2/3 续期，本阶段接受这一点。
- [`acme-client` 不再活跃维护] → 只用稳定的底层接口和公开的 `acme.axios`；需要替换时，范围只限 `acme.ts`。
- [证书机构故障或限额用尽时，新电脑拿不到证书] → 已有证书的电脑在剩约 1/3 有效期时开始续期，有这段时间的余量。
- 首次签发受证书机构对同一注册域名的新证书限额约束，部署者需参考 [Let's Encrypt 速率限制](https://letsencrypt.org/docs/rate-limits/)。
- Relay 控制者可以自己应答验证、另签一张证书；证书透明日志能用于发现冒签，不能事先阻止，见[中转的信任边界](../../../../docs/product/web-remote-access.md#中转的信任边界)。

## Migration

新增文件都在 `remote-relay/` 目录下，第一次需要时生成。已有的 `certificate.pem`（例如测试时手动放入的）只要可用就继续使用，到 2/3 有效期时续期。回滚：删除这些文件，或关闭中转。

# Tasks

## 1. 签发与续期

- [x] 1.1 TLS 入口：
  - `@codexhost/remote-relay` 新增 `./client-hello` 导出，`readClientHello` 参数放宽为 `Duplex`，超时等其他行为不变。
  - `RelayTls` 改为由外部设置正式证书和挑战证书，先读 ClientHello 再分流，10 秒期限覆盖读 ClientHello 和握手。

  验证：
  - 现有中转端到端测试继续通过。
  - 新增用例：无正式证书时，`acme-tls/1` 连接用挑战证书握手（TLS 1.2 和 1.3 各一次）；同一挑战的多条并发连接都完成；SNI 大小写不同仍匹配；没有挑战证书或 SNI 不符时关闭；普通连接在无证书时关闭；只发半个 ClientHello 后 10 秒关闭。
  - `npm run lint` 的边界检查通过。
- [x] 1.2 签发（`acme.ts`）：
  - 按 design 的步骤走账户、订单、授权（跳过已有效的）、挑战、finalize、下载。
  - 关闭库内重试，设置 30 秒请求超时；拦截器按请求所属轮次记录错误响应。
  - 自己轮询 authorization 和订单，不用 `waitForValidStatus`。
  - 一轮有编号和 10 分钟期限，作废后不再发请求、不写文件，只撤下自己设置的挑战证书。
  - 私钥用 `wx` 排他创建。
  - 支持 `CODEXHOST_RELAY_ACME_DIRECTORY`。

  验证：Pebble 集成测试（单独命令运行，`CODEXHOST_TEST_PEBBLE_DIR` 缺少时失败）覆盖：
  - 首次签发后，手机侧 TLS 客户端用 Pebble 签发根校验通过。
  - `PEBBLE_AUTHZREUSE=0` 和 `100` 两种授权路径。
  - 续期沿用证书私钥。
  - 经本机测试 HTTP 代理签发。
  - 关闭挑战应答时，authorization 以 HTTP 200 返回 `invalid`，被分类为验证失败。

  记录实际运行的命令和结果。
- [x] 1.3 调度与失败（`certificates.ts`）：
  - `nextAction`。
  - 注册成功时检查，以及每小时检查；证书到期即撤下。
  - 失败记录：绑定主机名和证书机构地址，每轮开始前写入，成功后删除。
  - 退避加只向后的抖动；遵守 `Retry-After`。
  - 按结构化字段分类，验证失败两次或遇到 CAA 时暂停。
  - 开关、重启、重新注册各自的清除规则。
  - 新证书确认可用后，先原子替换文件，再替换上下文。

  验证：
  - 单元测试覆盖：`nextAction` 的各种情况（可用、需续期、主机名不符、私钥不匹配、未生效、已过期、等待 `retryAt`、已暂停、记录属于其他主机名或地址）；退避序列和抖动范围；`Retry-After` 优先；失败分类；各清除规则；用模拟响应和可控时钟覆盖：429、超时、重启后等待、轮询返回 429 时按 `Retry-After` 等待、轮询等待期间作废后不再发请求、旧轮次的迟到响应不影响新轮次、写入记录时保留文件中更晚的等待时间。
  - Pebble 测试覆盖：关闭挑战应答后验证失败两次即暂停；注册被替换时作废这一轮；不可用的新证书被拒，旧证书保留。

## 2. 界面和文档

- [x] 2.1 状态：`WebRelayState` 增加 `certificate` 字段；连接设备页显示有效期、申请中、失败说明和下次重试时间、暂停提示。验证：Playwright 覆盖这些状态的文案，以及手机宽度下的布局。
- [x] 2.2 文档：
  - `docs/product/web-remote-access.md` 说明：证书自动申请、失败提示、证书透明日志会公开中转地址、`CODEXHOST_RELAY_ACME_DIRECTORY`。
  - 说明采用 TLS-ALPN-01，不做 DNS-01，也不做备用证书机构的自动切换。

  验证：文档与实现一致。

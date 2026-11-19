# Tasks

## 1. 中转核心

- [x] 1.1 协议：增加 `relay-name`、`relay-invite` 头，四个拒绝关闭码（4410–4413），以及 `/v1/notice` 路径。在线电脑、用量和 SNI 路由改为按地址名，SNI 接受合法的 DNS 标签。验证：现有 `packages/remote-relay` 测试全部通过（不提供检查时行为不变）。
- [x] 1.2 `createRelay` 增加 `check`、`onUsage` 选项和 `disconnect(name)`，并支持检查返回的限额和 `usedToday`。达到当日额度时向电脑发额度通知。README 补充这些选项和关闭码。验证：新增测试覆盖分配名字、四种拒绝、检查抛错、按检查返回的额度限制、从 `usedToday` 起算、`onUsage` 计数与额度一致、`disconnect` 后重连重新检查，以及额度通知。
- [x] 1.3 `createRelay` 增加可选的 `onRequest(request, response)`：控制地址上非协议的 HTTPS 请求交给它，不提供时仍返回 404。README 补充该选项。验证：测试覆盖提供与不提供两种情况，以及注册 WebSocket 和地址名转发不受影响。

## 2. 电脑端

- [x] 2.1 Web 服务：`service.json` 保存 `relayName`、`relayInvite`、`relayHostname`，`--relay` 改变时清除 `relayHostname`。注册时提交名字和邀请码。按关闭码处理被拒：4410–4412 时关闭中转并记录原因，4413 时重试。收到额度通知后记录恢复时间。`shared-contracts` 增加对应的状态字段。验证：在 `packages/web-server` 测试中用真实 Relay 加 `check` 覆盖上述各情况，以及取得地址后输入框不再出现所依赖的状态。
- [x] 2.2 连接设备页：未取得地址时，在启用按钮前显示地址名（4–20 位小写字母和数字，可留空）和邀请码输入框。关闭状态下显示被拒原因。显示"中转已满、正在重试"和"今日流量已用完"及恢复时间。补充中英文文案。验证：`relay-controls.test.ts` 覆盖填写、名字格式、各拒绝原因、额度提示，以及手机宽度下的布局。
- [x] 2.3 文档：更新 `docs/product/web-remote-access.md` 中的中转部分，说明地址名、邀请码和各提示。验证：文档与页面文案、规格一致。

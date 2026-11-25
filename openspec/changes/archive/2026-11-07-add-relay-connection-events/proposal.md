# Proposal

## Why

部署者仅收到双向合计字节，无法统计电脑在线、手机使用时长或区分 ACME 验证。核心需要提供可选事件，运营规则和持久化仍由部署者负责。

## What Changes

- 增加可选连接事件，报告电脑上下线、手机连接起止及双向字节数，区分 ACME。
- 用量回调附带方向、ACME 和额度触达信息，兼容现有双参数回调。

## Capabilities

### Modified Capabilities

- `remote-relay`：增加可选连接事件与方向用量报告。

## Impact

`packages/remote-relay` 的公开接口、注册与转发流程、测试及 README；不新增依赖，不改变未订阅时的行为。

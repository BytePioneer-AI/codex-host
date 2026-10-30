## Why

PR #242 的 CodeRabbit 复核发现，整数校验抛出的普通 TypeError 会使部分非法远端数据被误判为暂时不可用；Assistant start 的结算查找还会重复扫描游标之前的历史。

## What Changes

- 整数校验复用既有协议错误类型，保留校验条件和错误文案。
- 结算查找从已验证的 durable cursor 后按索引遍历，不复制数组。
- 补充错误码、不触发重连及不访问历史前缀的回归测试，更新验证记录。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `deepseek-versioned-web-protocol`: 明确非法整数保持 protocolError，以及结算查找限定在起始游标之后。

## Impact

仅涉及 Adapter 的 validation/session、相关测试、验证文档和 OpenSpec。README 不改，plan/todo 不纳入 PR；不新增依赖或公共接口。

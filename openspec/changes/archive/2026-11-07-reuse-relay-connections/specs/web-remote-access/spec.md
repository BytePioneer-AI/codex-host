## ADDED Requirements

### Requirement: HTTP 空闲连接复用

Web 的 HTTP/1.1 服务 SHALL 将响应完成后的空闲保持时间设为 120 秒，本机与中转共用。该设置 MUST NOT 延长请求头或请求体的接收期限，客户端可以提前关闭连接。

#### Scenario: 短暂停顿后继续操作

- **WHEN** 客户端完成请求、空闲超过 5 秒但不足 120 秒且未主动关闭连接
- **THEN** 下一次请求可复用同一条连接，不需要重新握手

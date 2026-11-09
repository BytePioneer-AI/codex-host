# Proposal

## Why

自建中转需要手动配置证书和续期，增加了搭建成本。控制地址应由中转自行管理证书，只要求公网 TCP 443 可达。

## What Changes

- 控制地址自动申请、持久化和续期证书；已有证书仍可选用。
- **BREAKING**：默认控制地址改为 `relay.<domain>`，显式配置不变。
- Compose 从源码构建并持久化数据，只开放 443；双语教程缩为五步。

## Decisions

- 使用 443 验证，不要求 80、外部证书工具或 DNS 凭据。
- 从源码构建，不发布镜像；中转保持独立，不依赖 Web 包。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `remote-relay`：修改部署配置中的控制地址默认值及证书生命周期。

## Impact

涉及 remote-relay、Web 教程及浏览器测试、部署文档。中转增加 acme-client 依赖，并更新可执行包边界检查；注册和手机字节转发协议不变。

# Spec Delta

## MODIFIED Requirements

### Requirement: 对外监听
`npm start web` 和 `preview.mjs` SHALL 默认监听 `0.0.0.0`，访问由 token 保护；`--host` 可以限定监听地址。发行版后台 Web SHALL 默认只监听 `127.0.0.1`，由用户开启后才对外。对外监听时，启动输出和连接设备页的网络地址 MUST 不包含本机 token，并 SHALL 提示局域网 HTTP 为明文传输。

#### Scenario: 默认启动
- **WHEN** 用户不带 `--host` 运行 `npm start web`
- **THEN** 局域网设备可以连接，未登录时只能看到登录页
- **AND** 启动输出列出不带 token 的网络地址和明文提示

#### Scenario: 限定为本机
- **WHEN** 用户以 `--host 127.0.0.1` 启动
- **THEN** 局域网设备无法连接

#### Scenario: 发行版默认
- **WHEN** 用户第一次运行 `codexhost web`
- **THEN** 局域网设备无法连接，直到用户开启直连或用 `--host` 指定

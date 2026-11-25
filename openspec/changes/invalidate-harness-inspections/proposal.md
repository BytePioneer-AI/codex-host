## Why

显式刷新 Harness 连接后，Web 选择器仍使用 Web 服务长期缓存的失败状态或旧模型列表，只有重启 Web 服务才能恢复。Host 需要向连接的 Web 客户端广播检查失效。

## What Changes

- Host 在 `refresh: true` 检查完成后发布带 cursor 与 harnessId 的 `harness-inspection-changed`。
- Web 按 Harness 清除所有 cwd 的检查缓存，Host hello 清除检查与插件列表缓存，并通知本机选择器重新读取。
- 保留普通读取的成功/失败缓存及 Adapter 原生检查语义，不引入 TTL、轮询或自动重试。
- 设置页手动刷新在已有检查结束后合并执行一次 availability 刷新。

## Impact

影响 shared-contracts、Host Runtime、Web server、Web 选择器及共享设置页诊断；不改变 Adapter、Desktop 选择器、Console server 或远程 Host 目录行为。

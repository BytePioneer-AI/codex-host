## 1. Claude 请求级 Usage 事实

- [x] 1.1 扩展 Claude 私有 `ClaudeLastRequestUsage` 与 native parser，保留 output Token、实际 Model、可选 Provider 和稳定 request ID，并覆盖 live frame 与 Transcript fallback
- [x] 1.2 增加 parser/transport 测试，证明同一 Assistant 完整 frame 可稳定识别且 Claude SDK 原始 payload 不越过 Adapter seam
- [x] 1.3 在 Claude Adapter 内加入按实际 Model/Provider 计价的请求费用函数；无法可靠定价时只返回 Token/CH，不猜测费用

## 2. Session 实时估算与 Result 校准

- [x] 2.1 为每个 `ClaudeHarnessSession` 增加独立的已校准基线、活动 Turn 请求去重集合及 input/output/cost 增量状态
- [x] 2.2 在每个 Root `message.completed` 上被动合并最新 CH、Context 近似值、Token 与可定价费用，并确保重复 Assistant frame 至多计入一次
- [x] 2.3 使用 `usage.result` 的 `modelUsage` 与 `total_cost_usd` 分字段校准 Session 累计值，清除对应 Turn 临时增量且不把 `result.usage` 当 Session aggregate
- [x] 2.4 增加长 Tool Turn、多请求、Turn 间 Model 变化、缺失 Result 字段和两个并发 Claude Session 隔离测试

## 3. 移除自动重量级刷新

- [x] 3.1 删除 Assistant、Tool completion 和普通 Turn terminal 上的自动 `getContextUsage()` 调用；Tool completion 不发布新的模型 Usage
- [x] 3.2 删除 Claude Transport 的实验 `getSessionUsage()` 调用及普通 Turn terminal Session Usage拉取，改由 Result 校准
- [x] 3.3 移除实验 `getPlanLimit()` 拉取和 Renderer inspection 触发路径，仅保留稳定 `rate_limit_event` 的账号级 5h/7d 合并
- [x] 3.4 更新现有回归测试，证明正常 Tool loop/Turn 不触发 `count_tokens` 或实验 Usage 控制请求

## 4. 按需精确 Context 刷新

- [x] 4.1 为 Harness Session 增加最小可选 Usage refresh 操作，并为固定 Thread Usage inspection 契约增加严格校验的 exact refresh 模式
- [x] 4.2 在 Claude Session 实现 Context single-flight、短成功 TTL、失败冷却、有界重试、generation 门禁与 close/fault 取消
- [x] 4.3 修复成功 Context 读取未退出重试循环的问题，并增加“首次成功只调用一次”与失败冷却测试
- [x] 4.4 增加同 Session 并发 refresh 合并、不同 Session 不合并、旧 Session/Model generation 结果被丢弃的测试
- [x] 4.5 在 Host Runtime 将 exact refresh 只路由到当前 Thread 的 owning Session，并保持响应/通知顺序与过期 Session 隔离

## 5. Renderer 详情交互

- [x] 5.1 在 Usage Popover 打开时立即展示缓存快照并异步请求 exact refresh，普通 Composer 绑定和 Usage 通知不自动请求精确 Context
- [x] 5.2 使用 Thread ID、Composer identity 和单调 generation 丢弃过期 exact 结果，失败时保留最近有效快照且不影响 Composer
- [x] 5.3 增加 Renderer 测试，覆盖打开即刷新、快速重复打开、切换 Thread/Composer、失败与更新后 Popover 重绘

## 6. 隔离、持久化与验证

- [x] 6.1 更新 Harness/shared contracts、Fake Harness 与 Host 测试，证明显式刷新不是通用查询通道且不同 Thread/Session Usage 不混合
- [x] 6.2 增加 Mapping Store/恢复测试，确认 usage、cost、context、requestId、估算增量和 refresh cache 均不持久化
- [x] 6.3 运行 Claude Adapter、Harness/shared contracts、Host Runtime 和 Renderer 的聚焦测试及相关 typecheck/lint，并记录未运行或受阻的检查

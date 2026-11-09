# Design

## 核心接口

- `onUsage(name, bytes, details)`：第三参数为 `{ direction: "upload" | "download", acme, quotaExceeded }`，upload 指手机到电脑；与额度共用增量计数，兼容双参数回调，不另加方向或额度回调。
- `onConnection(event)`：统一报告电脑成功上线/下线（地址名、IP、时间、已有下线原因），不依赖 `check`；手机开始/结束事件携带连接 ID、地址名、IP、ACME 标记、起止时间及双向累计字节。`close()` 等待关闭事件完成，供部署者批量写出最终统计。回调同步更新内存，不在核心持久化。

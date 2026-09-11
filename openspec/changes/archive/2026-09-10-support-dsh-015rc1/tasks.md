## 1. 规格与证据

- [x] 1.1 建立仅本地保留的 plan/todo，核实 upstream 基线与参考 RC 标签
- [x] 1.2 对照 012/015 源码追踪日志、流式、控制、命令与 Legacy 调用链
- [x] 1.3 编写 proposal、design、双版本与本地会话 delta specs，列明文档改写
- [x] 1.4 通过 OpenSpec strict 校验并进入 apply 阶段

## 2. 版本与 Legacy 清理

- [x] 2.1 删除 Legacy 协议实现、attach/fallback 和公开专属类型
- [x] 2.2 精确允许两个 RC，更新现有报错，保留认证与失败清理诊断
- [x] 2.3 移除 Legacy 专属依赖、打包项和测试，保留 Modern 所需依赖
- [x] 2.4 覆盖版本拒绝矩阵、并发选择、刷新、关闭和端点诊断

## 3. 015 协议与会话

- [x] 3.1 实现精确 012/V0 和 015/V3 profile、分页、header、seed 和事件解析
- [x] 3.2 支持系统 surface、引用/替换、新增 PTC/feedback/team/subagent 事件与不透明 ignorable 数据
- [x] 3.3 接入 Assistant baseline/start/chunk/end、durable message/attempt、重连与去重
- [x] 3.4 接通双版本创建、恢复、导入、Fork、回滚与 checkpoint 格式隔离
- [x] 3.5 按版本发送命令参数并保留权限/审批/问题/队列/停止确认语义
- [x] 3.6 清理 015 Fork 子会话继承待办并重新验证，防止冷恢复执行已回滚输入
- [x] 3.7 通过原生 export HEAD flush barrier 确认 015 持久化，避免 Windows 关闭丢失批量写入

## 4. 测试与质量

- [x] 4.1 补充脱敏 RC 协议样本、合法与非法边界、双版本功能回归
- [x] 4.2 运行整个 Adapter 及受影响 Host/共享/Renderer/发布测试
- [x] 4.3 添加可复现全 Adapter V8 覆盖率入口，四项指标至少 80%
- [x] 4.4 通过 TypeScript 构建、typecheck、lint/边界、改动格式与 diff 检查
- [x] 4.5 独立复核改动，修复发现问题，记录证据和未执行验证的边界

## 5. 文档改写与交付

- [x] 5.1 在专项文档更新支持版本与连接排障，保持项目及多语言 README 原样
- [x] 5.2 改写会话导入、消息修订、插件依赖/运行时说明中的受影响段落
- [x] 5.3 同步主 OpenSpec，保留旧归档事实并标明本变更取代的支持范围
- [x] 5.4 完成验证记录，同步 plan/todo/tasks 勾选和整体进度
- [x] 5.5 按逻辑单元中文提交、每五个提交推送并完成收尾推送
- [x] 5.6 通过 gh 引用相关 issue/PR，创建按完成状态编写的中文 draft PR

## Context

已复现 015 finish.failure.status=1.5 经 journal 变成 unavailable。012 chunk 也复用该整数校验；已有边界测试只断言抛出异常，未约束错误码。

## Goals / Non-Goals

修复错误分类与无效历史扫描；不扩展版本、重连规则或 Host 契约，不补无信息量的批量注释。

## Decisions

- boundedInteger 调用现有 fail，避免引入第二套错误包装。
- 事件序号已被校验为数组索引，直接从 startedAfterSeq + 1 遍历，保留首个匹配结算及现有身份条件。
- 使用现有测试辅助对象复现非法数据和历史访问计数，避免不稳定的耗时阈值测试。

## Risks / Trade-offs

共享整数校验也用于本地选项检查，统一错误类型后需回归既有构造和历史测试；不改变接受范围。

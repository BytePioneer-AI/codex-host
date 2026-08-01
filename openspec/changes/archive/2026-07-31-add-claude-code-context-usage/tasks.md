## 1. Claude SDK Context

- [x] 1.1 为Claude私有transport增加context pair类型、稳定SDK读取和严格malformed/null处理
- [x] 1.2 增加Hermetic SDK transport测试，覆盖有效、不可用、malformed及未启动Query

## 2. Claude Session Telemetry

- [x] 2.1 在Claude Turn终态后异步发布规范化Usage，并实现失败隔离、generation失效和lazy open保持
- [x] 2.2 增加Fake Adapter测试，覆盖发布顺序、读取失败、迟到结果和close失效

## 3. Codex Carrier

- [x] 3.1 让Protocol projector接受context-only快照，并只在Codex carrier中零填未知aggregate
- [x] 3.2 更新projector测试，覆盖context-only、完整aggregate和缺失context fail-closed

## 4. Validation

- [x] 4.1 运行相关Vitest、TypeScript、ESLint、格式和OpenSpec strict validation
- [x] 4.2 更新受影响的开发状态文档，明确Claude Usage范围与未执行的真实Desktop Gate

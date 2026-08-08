## 1. 标题兼容分类

- [x] 1.1 将主进程标题服务探测拆分为必要结构事实和已评审身份判断，定义有界 `unreviewed-title-service-identity` warning
- [x] 1.2 在必要结构通过但类名未知时继续安装ownership包装、Renderer reload/readiness，并保持已评审类名路径行为不变
- [x] 1.3 增加未知类名可继续、已评审类名无warning、服务路径/方法/函数结构失败仍fail closed的focused测试

## 2. 结构化启动Readiness

- [x] 2.1 定义Launcher与首次Desktop Controller共享的严格单行JSON readiness Schema、warning枚举和长度边界
- [x] 2.2 更新Desktop Controller生产入口，使完整生产链ready后输出空warning或脱敏warning，并保持技术异常走stderr/非零退出
- [x] 2.3 更新Launcher解析与状态机，严格拒绝malformed/未知readiness且不改变nonce-authenticated Attachment Server协议
- [x] 2.4 增加Controller/Launcher空warning、未知标题身份warning、malformed结果、EOF和超长输入测试

## 3. Desktop指纹与确认记录

- [x] 3.1 扩展平台安装发现，读取macOS version/build/官方ASAR integrity及Windows等价受信安装指纹，不因未知版本号本身拒绝启动
- [x] 3.2 实现严格、原子、拒绝符号链接/非普通文件的本地warning确认记录，键包含Desktop、codexhost和warning完整指纹
- [x] 3.3 增加相同指纹抑制重复提示、任一字段变化重新提示、记录损坏不跳过结构检查的跨平台测试

## 4. 兼容提示与固定操作

- [x] 4.1 在平台层定义`ContinueCodexhost | OpenLatestRelease | OpenStockCodex`公共Choice和中英文兼容提示文案
- [x] 4.2 Windows复用信息样式`TaskDialogIndirect`并保留安全回退，macOS实现等价`NSAlert`，不引入GUI框架
- [x] 4.3 实现只允许打开固定`https://github.com/BytePioneer-AI/codex-host/releases/latest`的跨平台外部链接操作
- [x] 4.4 将Launcher warning流程接入Runtime Descriptor发布前：继续/打开Releases记录确认并保持受管链，原版选择放弃描述符并完成有界清理
- [x] 4.5 实现基于已验证官方安装身份的原版Codex干净启动，证明新进程不继承`CODEX_CLI_PATH`或任何`CODEXHOST_*`环境
- [x] 4.6 增加三个Choice、默认继续、固定URL、受管链保留、原版链清理和平台UI回退测试

## 5. 脱敏诊断与发布一致性

- [x] 5.1 输出用户可理解的能力/原因摘要和技术reason code/observed identity，增加Prompt、Transcript、Model、Thread/Request ID、函数源码、凭据和用户路径缺失断言
- [x] 5.2 更新Desktop Controller Bundle、Launcher资源/平台构建和release contract测试，确保新版Launcher与Controller readiness原子发布
- [x] 5.3 更新PRD、工程文档和开发清单，明确指纹只触发/记忆warning，不形成Desktop版本白名单或兼容矩阵

## 6. 验证与收口

- [x] 6.1 使用合成未来类名执行自动化启动Gate，证明Title Policy、ownership、Draft Prewarm、Renderer Adapter和Agent控件ready且warning只提示一次
- [x] 6.2 在真实Windows和macOS验证继续、打开Releases、使用原版Codex、重复启动确认及Desktop/codexhost变更后重新提示，记录脱敏结论
- [x] 6.3 运行focused TypeScript/Rust/release测试、`npm run check`、`npm run build`、严格OpenSpec校验和`git diff --check`，解决受影响失败

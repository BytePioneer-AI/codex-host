## 1. 回归信号与Renderer入口

- [x] 1.1 增加发布回归测试，证明当前Payload的Renderer脚本必须是自安装IIFE且必须存在生产Controller消费者
- [x] 1.2 提取共享Renderer安装函数，增加独立生产入口并保持Probe入口行为
- [x] 1.3 更新Renderer构建命令和测试，分别生成库、生产IIFE和Probe IIFE

## 2. Desktop Control生产Module

- [x] 2.1 在`desktop-control`实现Inspector等待、Electron webContents脱敏检查和唯一primary选择测试
- [x] 2.2 实现Control Session的Title Policy、reload、readiness、Prewarm Policy和Renderer安装固定顺序
- [x] 2.3 实现Adapter ready验证与Renderer reload恢复，结构不支持时fail closed
- [x] 2.4 将`tools/renderer-binding`切换为Control Session调用方，迁移选择测试并保留Observer、报告与Claude Gate

## 3. Desktop Controller发布入口

- [x] 3.1 增加只接受loopback Inspector和绝对Renderer文件的Controller CLI参数与失败测试
- [x] 3.2 实现Controller readiness、持续恢复、信号关闭和受控stderr行为
- [x] 3.3 增加Desktop Controller esbuild Release Bundle与metafile审计，拒绝Tool、Test和未审查输入

## 4. Launcher生命周期

- [x] 4.1 扩展安装资源布局，解析Desktop Controller和Renderer并覆盖普通/App带空格路径
- [x] 4.2 扩展Desktop启动参数契约，生产只传随机`127.0.0.1` Inspector且不启用Chromium CDP
- [x] 4.3 实现Controller命令、`ready`超时和Desktop/Controller双进程监督测试
- [x] 4.4 在Controller未ready、异常退出或恢复失败时终止本次Desktop，Desktop退出时清理Controller

## 5. 发布Payload与平台封装

- [x] 5.1 构建并复制`desktop-controller.mjs`和生产Renderer IIFE，更新固定Payload allowlist和禁止内容审计
- [x] 5.2 更新macOS App与Windows WiX文件列表，保持随包相对路径和签名验证
- [x] 5.3 更新发布测试，证明库入口、Probe与Tool不进入公开Payload

## 6. 真实验证与证据

- [x] 6.1 运行Probe聚焦测试和既有Renderer/Title/Prewarm/Host回归测试，确认迁移不改变已验证行为
- [ ] 6.2 生成macOS arm64 App并验证点击后出现Codex/Pi/Claude Code、选择Pi首轮进入真实Pi且页面状态locked
- [ ] 6.3 验证Renderer reload后Agent控件和Policy恢复，Controller失败时Desktop fail closed
- [x] 6.4 运行全仓`npm run check`和OpenSpec strict validation，更新安装包与Renderer验证记录

## 7. Claude Code默认生产组合

- [x] 7.1 更新生产规格和回归测试，默认Agent列表固定为Codex/Pi/Claude Code且不读取开发开关
- [x] 7.2 生产Host默认注册Claude Code Adapter，缺少可执行文件或认证时fail closed且不影响Host启动
- [x] 7.3 将Claude Agent SDK纳入Host Bundle闭包审计，拒绝可选平台Claude Code包并补齐许可证与固定Payload
- [x] 7.4 更新macOS/WiX文件清单、发布测试、全仓检查和OpenSpec strict validation
- [ ] 7.5 生成macOS arm64 App并验证Claude Code控件、真实首轮、locked状态和reload恢复

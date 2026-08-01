## Why

当前可分发App会启动官方Codex Desktop并接通Shim与Host Runtime，但只把Renderer Extension库文件复制进Payload，没有生产Controller执行它；真实Renderer安装顺序仍只存在于开发Probe Runner。结果是安装产物显示Stock UI而后端默认Pi，既缺少Agent控件，也存在用户界面与实际路由不一致的风险。

## What Changes

- 在`desktop-control`中建立正式Renderer Control Session，拥有主进程Inspector连接、主Renderer选择、Title Policy、Draft Prewarm Policy、生产Renderer注入和页面重载恢复。
- 把`tools/renderer-binding`中具备生产语义的选择与注入编排迁入该Module；Probe改为调用同一Interface，Observer、报告和开发开关继续留在`tools/`。
- 为Renderer Extension增加独立的Codex/Pi/Claude Code生产自安装入口；Probe继续复用同一安装实现与诊断配置。
- 构建并随包分发`desktop-controller.mjs`与生产Renderer Bundle，不再把只导出库接口的`dist/index.js`当作可执行脚本。
- 让Launcher使用随机loopback Inspector端口启动受控Desktop和私有Node Controller，等待Renderer Ready后继续监督；Controller失败时终止本次Desktop而不是静默运行Stock UI。
- 将Launcher Agent作为生产Composer初始选择传给Controller，同时把Host未标记fallback固定为Codex；Pi继续使用既有transport carrier，保证可见Codex/Pi选择与实际Harness一致。
- 在Renderer重载后重新建立readiness、prewarm bridge和Agent UI；结构或版本不匹配时保持fail closed。
- 增加Module级回归测试、Probe兼容测试、发布Payload审计和真实App点击验收。

## Capabilities

### New Capabilities

- `production-renderer-launch-chain`: 定义安装后Launcher、Desktop Controller与Renderer Extension的生产组合、三Agent生命周期、fail-closed和重载恢复契约。

### Modified Capabilities

- `cross-platform-release-staging`: 无参数入口仍初始选择Pi，但发布Payload增加Claude Agent SDK运行闭包及许可证；Host未标记请求不再作为隐式Pi选择。
- `registered-harness-routing`: 生产Host默认注册Pi与Claude Code，不再要求开发环境开关。
- `versioned-renderer-agent-routing`: 默认生产Agent列表从Codex/Pi扩大为Codex/Pi/Claude Code。

现有Composer transport、标题隔离和隐私行为保持不变，生产链直接复用已验证的Claude transport与HarnessAdapter实现。

## Impact

- `packages/desktop-control`新增深Module与三Agent Release Controller入口。
- `packages/renderer-extension`拆分生产入口和Probe入口。
- `tools/renderer-binding`删除生产编排副本并改用`desktop-control`。
- `crates/launcher`与`crates/platform`增加Inspector启动参数、Controller readiness、初始Agent传递和双进程监督。
- `scripts/release`新增Desktop Controller Bundle，更新固定Payload allowlist和平台安装定义。
- 安装产物新增`app/desktop-controller.mjs`；公开Renderer默认启用Codex、Pi与Claude Code，Host Bundle包含Claude Adapter与Agent SDK但不包含Claude Code可执行文件。

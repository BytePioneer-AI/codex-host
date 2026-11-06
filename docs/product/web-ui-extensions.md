# Web 界面扩展

Web 设置中的「界面扩展」（Interface extensions）支持安装、启用、禁用和卸载预构建的 DSH Web 包。插件通过原生 Cordis Loader/Include、客户端模块、主题和 UI 插槽运行，并可由原包服务端入口注册配套 Web 路由。安装记录属于 Web 服务，影响连接该服务的页面；它们与 Harness 插件目录、Adapter 和 Thread 执行路径分别管理。

管理列表展示插件名称、版本、启用状态和开关；点击条目进入详情，查看完整安装来源并确认卸载。列表及详情中的项目链接优先使用 GitHub 地址，否则使用包声明的主页、仓库或有效网页安装来源；没有可用地址时不显示链接按钮。地址从已安装包的 `repository`、`homepage` 和安装来源读取，已有安装无需重新安装；仅接受不含内嵌凭据的 HTTP(S) 链接，不执行包代码，也不根据包名推测项目地址。

图标、显示名称和说明遵循 DSH 的[插件展示元信息规范](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-package.md#5-add-optional-plugin-display-metadata)，读取器适配自官方 `app-boot/package-meta.ts`，来源记录在 `apps/web-ui/import-manifest.json`。名称和说明通过 Node ESM exports 读取 `locale/en.json` 及同目录的语言文件，按当前 DSH 语言链逐字段回退；包根插件可从其导出的 `package.json` 补充名称和说明。列表说明只展示一行，详情展示完整说明；本地化名称不改变安装身份和包名。

图标优先读取导出清单中的 `icon` 相对路径，未声明时读取 `./icon` 导出，不扫描文件猜测图标。支持 SVG、PNG、JPEG、WebP，原始文件不超过 256 KiB；清单图标在解析符号链接后仍须位于清单目录内，导出图标须属于插件包。服务端以图片 data URL 返回，页面以 `img` 渲染；缺失或解码失败时显示默认插件图标。非法声明或不可读文件提供独立的元信息诊断，保留有效文字，不将其视为插件加载失败，也不阻止启停和卸载。读取元信息不执行插件入口，不需要启用或重新安装插件；元信息不写入安装记录。

当前支持可信 Web 插件的前后端协同加载、管理和故障恢复，不启动另一套 DSH Agent Runtime。完整主题选择与配置持久化、更多面板和展示插件的兼容验收，以及 codexhost 原生格式和 GUI 第三方插件运行时仍未实现。分类和后续边界见[界面扩展插件方案](../proposals/ui-extension-plugins.md)。

## 安装与生效

在运行 Web 的电脑上，通过启动输出中的本机链接登录，进入「设置 → 界面扩展 → 添加扩展」。管理请求必须通过已有的[本机访问校验](standalone-web.md#访问认证)；手机、局域网和反向代理访问只显示本机管理提示。`--no-auth` 不授予插件管理权限。

添加弹窗沿用 DSH 的包名或地址输入方式，支持以下来源：

| 来源 | 输入方式 |
| --- | --- |
| npm 发布包 | 直接输入 `package-name` 或 `@scope/package-name`；也可以带版本、范围或标签，例如 `package-name@1.2.3`。这些名称只是格式示例 |
| GitHub 仓库 | `https://github.com/owner/repository` 或 `github:owner/repository`，可附加 `#分支`、`#标签` 或 `#commit`；仓库根目录须包含插件包及预构建客户端 |
| 本机目录 | 运行 Web 的电脑上的插件目录绝对路径，例如 `/absolute/path/plugin`；安装为独立副本，原目录后续修改不会自动更新已安装插件 |
| 本地预构建归档 | 运行 Web 的电脑上的 `.tgz` / `.tar.gz` 文件绝对路径 |

可选择 npm 官方源、中国大陆镜像源或自定义 HTTP(S) 源。选择的源用于 npm 包和依赖下载，不代理 GitHub 仓库访问；不自动切换到其他源。直接安装的带 scope 包也使用所选源；依赖包自己的 scope 配置沿用 npm 规则。自定义源地址不接受内嵌账号密码、查询参数或片段，私有源凭据沿用本机 npm 配置。目录和归档路径指运行 Web 的电脑，不是手机或其他浏览器所在设备。GitHub 入口仅支持公开仓库；其他 Git 服务或私有仓库可先准备本机目录，不支持任意远程压缩包 URL。

运行 Web 的机器需要有可调用的 npm。包名可以省略版本，安装记录始终保存实际安装版本。安装在独立暂存目录完成，校验包身份、客户端入口、依赖和资源后再登记。GitHub 来源获取仓库归档，npm 明确禁用生命周期脚本；不运行准备、安装或构建脚本，纯安装不执行插件入口。仅含源码、需要构建后才能生成客户端产物的包会被拒绝。

**启用带 Host 入口的包会执行原生服务端代码，不仅加载客户端。** 不希望执行的包应保持禁用；`--safe-mode` 在导入用户代码前跳过用户插件。

新安装的扩展默认禁用。启用、禁用和卸载由管理操作的串行队列直接应用，无需重启 Web 或共享 Host；普通页面由 DSH 模块图自动同步，断线重连时接收最新图。首个插件启用前和最后一个插件禁用后，通知通道均保持运行。仅通过首页初始化生效的 HTML、脚本或注入需要刷新页面，管理界面对此提供提示；它们不会被描述为已在现有页面动态应用。

卸载先移除登记，再等待相关 Cordis 实例释放，最后清理安装文件。未受影响的插件及内置终端、文件和 Office 服务不重建。下次启动也会清理未登记的残留安装。当前不支持同一个包并存多个版本或原地升级，安装其他版本前需要卸载已有版本。源码及发行入口使用相同的 HMR 插件组合；开发模式另有独立的外壳重建刷新通道。

## 当前兼容边界

包或其原生 bundle 必须贡献 Web 客户端入口，并提供 DSH 原生模块格式的预构建产物。启用及启动恢复时按原包声明组合 bundle patch、配置和入口，执行启用包的服务端代码；只有客户端的包不会将浏览器入口导入 Node。仅有 `./client` 导出并不能保证兼容；插件需要的模块、配置和服务必须在当前 Web 中真实存在。

- 原生 `ClientModules` 装配主客户端 JavaScript 和同目录的 `client.*.js` 分块，支持内嵌 CSS。图片、独立 HTML/JS/CSS、字体等由插件自己的 `webServer` 路由提供；不自动公开整个安装目录，也不按插件名添加资源映射。
- 插件 HTTP 路由使用现有地址和认证；写请求及连接升级遵守同源约束。原包自行决定方法、状态、响应头和缓存语义。内置 API、连接通道、核心资源和恢复入口保持原归属，路由冲突明确失败。
- 外部插件与内置插件使用同一客户端启动图，并复用宿主的 React、Cordis 和插槽模块。外部包不能以相同模块身份替换内置模块。
- 检查声明的客户端模块依赖、`engines.dsh` 和宿主运行时 peer 版本。源码模式读取实际构建依赖；发行包携带 `client-runtime-versions.json` 和共享 Web 运行模块，不以安装插件时下载的依赖树冒充宿主版本。安装包的框架导入指向嵌入宿主实例；发行目录移动后仍须保留其 `node_modules/`。缺失必需模块、版本冲突或无法确认的必需版本会阻止启用。
- 客户端代码和 JavaScript 分块在插件装配时形成资源快照；Loader 增删通过 ClientModules 更新模块图，由官方 client-hmr 通知页面。开发构建变化沿用官方 bundle 监听，不提供 Node 模块代码替换或安装包原地升级。外置资源请求携带版本时，旧版本或未知版本返回未找到，避免旧页面缓存新版分块。
- 主题和增量插槽按包逐项验证；私有 DOM/CSS 依赖不获得跨版本兼容保证。插件可使用现有 Web 后端服务，但缺失的必需服务会使启动装配失败；不为插件补造 Agent、Provider、tools/hooks、工作流或会话存储能力，不改变 Harness 执行与 Thread 数据归属。

内置品牌在 `sidebar.brand.mark`、`sidebar.brand.name` 和 `conversation.hero.brand.mark` 三个槽位提供 `priority: 1` 的回退内容，允许原生主题以默认优先级提供自己的品牌。主题的品牌文字和图形按原包显示，不自动改写为 codexhost。

扩展是与 Web 同进程、与页面同权限的可信代码。Cordis 管理路由、组件、订阅及 disposer 的生命周期，不提供沙箱、权限审批或任意副作用隔离；静态检查与一次成功加载也不代表包的所有功能已经验证。

## 状态与持久化

安装包和启用选择保存在当前 [Web 数据目录](standalone-web.md#web-数据目录)，默认是 `~/.codexhost/web/`，与产品发行目录分离：

```text
<Web 数据目录>/ui-extensions/
  installed.json
  packages/<安装 UUID>/node_modules/<包名>/
```

`installed.json` 记录精确版本、来源、安装时间和格式，当前格式为 `dsh`、支持目标为 `web`。`enabledTargets` 记录用户保存的启用选择；管理响应中的 `loadedIds` 仅表示服务端当前已装配的扩展，不持久化，也不等于浏览器插件已经成功激活。

当前界面扩展配置以安装与启用信息为主，没有通用第三方配置编辑器。既有浅色/深色等浏览器偏好沿用本地存储规则，不代表任意自定义主题 ID 或第三方设置都已接通保存和恢复。

安装交互适配自 DSH `ui-plugin-manager` 的弹窗和基础组件，来源解析复用其 `plugin-manager/install-spec` 的独立代码；Web 安装记录、RPC 与客户端兼容校验由 codexhost 管理，不挂载 DSH 的完整插件后端。

安装和状态写入失败会保留此前登记的安装记录。注册文件损坏时停止加载用户扩展，管理页显示读取错误并拒绝覆盖该文件；需要停止对应 Web 服务后恢复有效的 `installed.json` 备份。产品不会修改 Harness 插件启用文件或原生 DSH profile。

## 故障恢复

| 入口 | 作用 | 对已保存启用选择的影响 |
| --- | --- | --- |
| `/extensions` | 独立管理页面，不加载 DSH 页面外壳、用户客户端或用户首页注入，可禁用或卸载问题包 | 只有用户提交的操作才修改选择 |
| `/?extensions=off` | 当前页面仅使用内置界面，不应用用户首页注入；其他页面仍按正常启动图运行 | 不修改 |
| `--safe-mode` | 启动时不导入用户 Host 入口，也不装配用户客户端 | 保留，仍可通过管理页修改 |

页面级恢复不会停止已经运行的服务端扩展。需要停止其服务端代码时，可直接禁用；`--safe-mode` 可在启动时完全跳过用户代码。

安装或启用时的静态校验失败会返回错误。可捕获的入口加载失败记录原因并释放失败实例，不将其计入已加载集合；未受影响的实例及内置服务继续运行。已保存的选择与服务端实际加载结果分开，修改其他插件不会自动重试失败包；用户可显式重新启用或通过独立恢复页禁用它。已有服务依赖的暂停和恢复由 Cordis 处理。官方图通知描述客户端期望集合，不保证服务端所有入口均已激活，也不保证每个浏览器均已应用成功。

需要整个服务以仅内置模式启动时，源码工作树可运行：

```sh
npm start web -- --no-build --keep-host --safe-mode
```

`preview.mjs` 和直接 Web server 入口也接受 `--safe-mode`。保留原来的数据目录和端口，在恢复页禁用问题包；之后去掉 `--safe-mode` 重启并刷新页面。客户端脚本阻塞当前页面时，优先直接打开 `/extensions`，不要依赖问题插件所在页面完成恢复。

普通插件禁用后，其客户端贡献及受模块生命周期管理的样式自动移除；首页初始化注入需要刷新。卸载不承诺撤销第三方插件的任意副作用或其已对外部系统产生的影响。

## 原包验证范围

### 热加载验收

macOS、Node 24.18.0、Chromium 上，未修改的 Blackgold 1.0.0 和 Maid Atelier 0.1.9 使用下列固定归档完成源码及仓库外发行热加载检查。发行包携带实际编译的原生 Launcher，打包后整体移出仓库运行，依赖解析不使用仓库的 `node_modules`。

| 检查 | 源码 | 仓库外发行 |
| --- | --- | --- |
| 原包安装默认禁用，启用、禁用、再次启用、运行中卸载 | 两种原包通过 | 两种原包通过 |
| 两个普通页面无刷新同步，断线重连追上最新图 | 通过 | 通过 |
| 原包样式出现/清理、恢复页不订阅外部图 | 通过 | 通过 |
| Maid 三个人物图片、宫殿/边框图片响应，禁用和卸载后路由消失 | 通过 | 通过 |
| 启停前打开真实 PTY，五阶段保持同一 shell PID、变量、文件写入和回显 | 两种原包通过 | **未通过**：安装任何插件前，终端已因缺少 `@xterm/headless` 无法打开 |
| fake Host 聊天、会话事件及文件侧栏 | 无插件、Blackgold、Maid 均通过 | 无插件、Blackgold、Maid 均通过 |
| 资源设置页跨页面同步 | **未通过** | **未通过** |

资源设置的无插件对照复现 Host 空闲超时为 42、页面仍显示 30；主题运行也有另一页面等待超时输入框超时的失败，不能据此宣称完整设置回归通过。发行 PTY 失败发生在插件安装前，与原包热加载测试分别报告。完整验收仍需这两个问题解决后的回归。

[原包测试](../../packages/web-server/test/browser/dsh-web-plugin-packages.test.ts)分别提供 `across pages and recovery` 与 `with an existing PTY` 用例；后者必须实际打开终端，不以接口存在代替存活证据。`CODEXHOST_TEST_DSH_EXTENSION_ARCHIVE`、`CODEXHOST_TEST_MAID_ARCHIVE` 指向原归档；`CODEXHOST_TEST_WEB_BUNDLE` 指向仓库外 `app/server.mjs`；`CODEXHOST_TEST_EXTENSION_SCREENSHOTS` 保存截图、阶段、原包哈希、资源状态及 PTY PID/回显记录。缺归档的跳过不算验收通过。测试数据及进程隔离，聊天使用 fake Host，不发起真实模型请求。

以下各包章节还保留其重启加载、安装来源及资源兼容记录；Open Sea 的热加载未在上述矩阵中执行。

### Maid Atelier 与 Open Sea

官方 npm 原包 `@smalltailqwq/dsh-client-ui-skin-maid-atelier@0.1.9` 和 `open-sea-skin@1.2.7` 分别在 macOS、Node 24.18.0、Chromium 上完成源码及仓库外发行运行的安装、启用、重启、展示、页面恢复、禁用和重启后路由消失检查。安装后核对 Host/client 入口哈希；未修改原包，不将艺术资源纳入产品发行。两种主题分开运行，不承诺同时叠加。

| 对象 | SHA-256 |
| --- | --- |
| Maid npm 归档 | `4db0498fbc9b3079f7183b9456fc60c9354c54e9e87c2f88ec27ef97b2e76416` |
| Maid `lib/index.js` | `ccfd569f251eaf073532536eea231a4e4df54a3e73e810b488713ebb7af1ce9f` |
| Maid `lib/client.js` | `b146f8ae463987f8e3f54da0c28777dd5ea98e8d773bbf8b42512e2f3efc0b57` |
| Open Sea npm 归档 | `2da120caef2bd120a1ccee8d40929515339a8f0aada1124ea85084b6370ba586` |
| Open Sea `plugin/index.js` | `dc8a69166ef5c3ed8a2fb8cafc3b79b1feed3025326cfd8642d27bba4f2fda03` |
| Open Sea `plugin/client.js` | `6cced90ca2737216e053bebcfedaa574f88fa60d444eda277582e2a288e6dc2c` |

Maid 验证人物、宫殿背景、边框与图片响应；Open Sea 验证 iframe 的实际海洋画布及 HTML、JS、CSS、字体响应。浏览器验收保存截图、资源状态和错误观测，未出现页面执行异常。Open Sea 使用插件自身的 Three.js 渲染路径；无头 Chromium 验收允许 SwiftShader，不代表真实 GPU、所有浏览器或移动设备均可运行。

[原包浏览器测试](../../packages/web-server/test/browser/dsh-web-plugin-packages.test.ts)使用 `CODEXHOST_TEST_MAID_ARCHIVE`、`CODEXHOST_TEST_OPEN_SEA_ARCHIVE` 指向上述归档；`CODEXHOST_TEST_WEB_BUNDLE` 可指定仓库外的 `app/server.mjs`，`CODEXHOST_TEST_EXTENSION_SCREENSHOTS` 保存截图和观测。缺少归档时跳过，不能据此宣称通过。核心回归可用 `CODEXHOST_TEST_WEB_EXTENSION_DIRECTORY` 在隔离测试实例中装配未修改的已解压包。

完整核心回归尚未通过：无插件基线的资源设置页也存在空闲超时跨页面更新不实时同步的问题（Host 值为 42，页面仍为 30）。原包展示及恢复验收不等于所有核心设置流程已验收。

### Blackgold

真实样本为作者仓库中的 `@frostgao/dsh-theme-blackgold@1.0.0`，固定 [commit `da5f2bb5e44ff20de469c7bca2ec8427f225c33d`](https://github.com/frostgao/dsh-theme-blackgold/tree/da5f2bb5e44ff20de469c7bca2ec8427f225c33d)。该样本使用包含预构建 `lib/client.js` 的[作者归档](https://codeload.github.com/frostgao/dsh-theme-blackgold/tar.gz/da5f2bb5e44ff20de469c7bca2ec8427f225c33d)，保存为本地 `.tgz` 后安装；包源码和客户端产物未修改。验证时 npm registry 对该包返回 404，因此这里不提供该包的 npm 安装示例。

| 校验对象 | SHA-256 |
| --- | --- |
| 作者归档 | `f6ef545dec6ded0ffaacec8be6ce64026f4b79141888fe5a368f62a632a92957` |
| 原包 `lib/client.js` | `ba0438d0ccfdac090819bf4a88abbfd2b122af8d6a1a3912da5edce19bb03f92` |

macOS 上的 Chromium 浏览器验收在源码模式和仓库外的发行目录均覆盖设置页安装、保存启用选择、重启加载、浅色金色主题、原包品牌槽位、仅内置页面、独立恢复页禁用及重启后恢复内置界面。安装后核对原始 `client.js` 哈希。原包品牌显示 DSH 字样和金色标记，这是插件自身的输出。故障夹具覆盖客户端运行异常、资源丢失和整服务安全模式；这些夹具不算新的第三方兼容样本。

安装弹窗还覆盖直接输入 `https://github.com/frostgao/dsh-theme-blackgold#da5f2bb5e44ff20de469c7bca2ec8427f225c33d` 的原包流程。隔离的 npm 测试源验证不带版本的 scoped 包名和自定义源选择；本机目录测试在安装后删除源目录，再启用和重启，验证使用独立副本。真实 npm 的脚本标记测试覆盖目录包及其 Git 依赖的准备子进程，确认生命周期脚本没有执行。

原包另含依赖具体 SVG 和 DOM 结构的装饰 CSS，上述验收不承诺这些细节在其他页面或版本的表现。Windows、Linux、手机端及其他第三方插件尚未进行同等原包验收；自定义主题选择器和配置持久化仍不属于当前交付。验收使用隔离 Web 数据和模拟 Host，不发起真实模型请求。

相关自动化入口是 [安装与持久化测试](../../packages/web-server/test/ui-extensions.test.ts)、[客户端管理测试](../../tests/dsh/web-ui-extensions.spec.ts)和[浏览器生命周期测试](../../packages/web-server/test/browser/ui-extensions.test.ts)。真实归档测试仅在设置 `CODEXHOST_TEST_DSH_EXTENSION_ARCHIVE` 时执行；真实 GitHub 来源测试通过 `CODEXHOST_TEST_DSH_EXTENSION_GITHUB` 指定上述固定地址。跳过真实来源的结果不能作为原包兼容证据。

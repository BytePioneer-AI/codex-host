# Web 界面扩展

Web 设置中的「界面扩展」（Interface extensions）支持安装、启用、禁用和卸载预构建的 DSH 客户端包。插件通过已有 Cordis 客户端模块、主题和 UI 插槽扩展页面。安装记录属于 Web 服务，影响连接该服务的页面；它们与 Harness 插件目录、Adapter 和 Thread 执行路径分别管理。

当前交付的是 DSH Web 插件兼容的第一步：外置包加载、管理和故障恢复。完整主题选择与配置持久化、更多面板和展示插件的兼容验收，以及 codexhost 原生格式和 GUI 第三方插件运行时仍未实现。分类和后续边界见[界面扩展插件方案](../proposals/ui-extension-plugins.md)。

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

运行 Web 的机器需要有可调用的 npm。包名可以省略版本，安装记录始终保存实际安装版本。安装在独立暂存目录完成，校验包身份、客户端入口、依赖和资源后再登记。GitHub 来源获取仓库归档，npm 明确禁用生命周期脚本；不运行准备、安装或构建脚本，也不加载插件的默认 Host 入口。仅含源码、需要构建后才能生成客户端产物的包会被拒绝。

新安装的扩展默认禁用。点击「启用」后，重启 Web 并刷新已打开的页面。禁用和卸载也采用相同的生效方式；界面显示已保存的选择和待重启状态，不自动重启服务。当前不支持同一个包并存多个版本，安装其他版本前需要卸载已有版本。

源码工作树可复用已经构建的产物，并明确保留共享 Host：

```sh
npm start web -- --no-build --keep-host
```

使用自定义 `--port`、`--data` 或其他启动参数时，重启时保留它们。打包运行时使用原来的 `preview.mjs` 启动方式重启 Web。扩展变化不要求重启 CH Host；Web 重启会断开页面连接，并关闭 Web 自己持有的终端。共享 Host 上的任务继续遵循原有生命周期。

## 当前兼容边界

包必须声明 Web 客户端入口，并提供 DSH 原生客户端模块格式的预构建产物。宿主读取包元数据和客户端文件，不通过执行服务端代码来发现资源。仅有 `./client` 导出并不能保证兼容；插件需要的模块、配置和服务必须在当前 Web 中真实存在。

- 加载主客户端 JavaScript 和同目录的 `client.*.js` 分块，支持随客户端代码内嵌的 CSS。当前不提供任意图片、字体、独立 CSS 或其他静态资源目录的通用分发。
- 外部插件与内置插件使用同一客户端启动图，并复用宿主的 React、Cordis 和插槽模块。外部包不能以相同模块身份替换内置模块。
- 检查声明的客户端模块依赖、`engines.dsh` 和宿主运行时 peer 版本。源码模式读取实际构建依赖；发行包携带 `client-runtime-versions.json`，不以安装插件时下载的依赖树冒充宿主版本。缺失必需模块、版本冲突或无法确认的必需版本会阻止启用。
- 客户端代码和 JavaScript 分块在 Web 启动时形成资源快照。安装、卸载或修改磁盘文件不会改变运行中页面所使用的启动图；需要重启和刷新。外置资源请求携带版本时，旧版本或未知版本返回未找到，避免旧页面缓存新版分块。
- 使用主题接口和增量插槽的插件可按包逐项验证。完整布局替换、依赖私有 DOM/CSS 层级的修改，以及需要新增后台服务、RPC、Agent tools/hooks、模型 Provider 或会话存储的插件不在当前兼容范围内。

内置品牌在 `sidebar.brand.mark`、`sidebar.brand.name` 和 `conversation.hero.brand.mark` 三个槽位提供 `priority: 1` 的回退内容，允许原生主题以默认优先级提供自己的品牌。主题的品牌文字和图形按原包显示，不自动改写为 codexhost。

客户端扩展与页面共享浏览器权限。Cordis 负责组件和订阅的生命周期，不提供恶意脚本隔离；静态检查与一次成功加载也不代表包的所有功能已经验证。

## 状态与持久化

安装包和启用选择保存在当前 [Web 数据目录](standalone-web.md#web-数据目录)，默认是 `~/.codexhost/web/`，与产品发行目录分离：

```text
<Web 数据目录>/ui-extensions/
  installed.json
  packages/<安装 UUID>/node_modules/<包名>/
```

`installed.json` 记录精确版本、来源、安装时间和格式，当前格式为 `dsh`、支持目标为 `web`。`enabledTargets` 记录用户保存的启用选择；管理响应中的 `loadedIds` 仅表示服务端本次启动已装配的扩展，不持久化，也不等于浏览器插件已经成功激活。

当前界面扩展配置以安装与启用信息为主，没有通用第三方配置编辑器。既有浅色/深色等浏览器偏好沿用本地存储规则，不代表任意自定义主题 ID 或第三方设置都已接通保存和恢复。

安装交互适配自 DSH `ui-plugin-manager` 的弹窗和基础组件，来源解析复用其 `plugin-manager/install-spec` 的独立代码；Web 安装记录、RPC 与客户端兼容校验由 codexhost 管理，不挂载 DSH 的完整插件后端。

安装和状态写入失败会保留此前登记的安装记录。注册文件损坏时停止加载用户扩展，管理页显示读取错误并拒绝覆盖该文件；需要停止对应 Web 服务后恢复有效的 `installed.json` 备份。产品不会修改 Harness 插件启用文件或原生 DSH profile。

## 故障恢复

| 入口 | 作用 | 对已保存启用选择的影响 |
| --- | --- | --- |
| `/extensions` | 独立管理页面，不加载 DSH 页面外壳或用户扩展，可禁用或卸载问题包 | 只有用户提交的操作才修改选择 |
| `/?extensions=off` | 当前页面仅使用内置界面；其他页面仍按正常启动图运行 | 不修改 |
| `--safe-mode` | 整个 Web 服务启动时不装配用户扩展 | 保留，仍可通过管理页修改 |

安装或启用时的静态校验失败会返回错误。启动时外部插件组合失败，Web 回退到内置界面，并记录加载错误；用户仍可通过独立恢复页禁用问题包。已保存的启用选择与启动失败分开，重启前应先处理问题包，避免再次尝试相同组合。

需要整个服务以仅内置模式启动时，源码工作树可运行：

```sh
npm start web -- --no-build --keep-host --safe-mode
```

`preview.mjs` 和直接 Web server 入口也接受 `--safe-mode`。保留原来的数据目录和端口，在恢复页禁用问题包；之后去掉 `--safe-mode` 重启并刷新页面。客户端脚本阻塞当前页面时，优先直接打开 `/extensions`，不要依赖问题插件所在页面完成恢复。

禁用后重启、刷新可移除相应界面和样式，但卸载不承诺撤销插件已对外部系统产生的副作用。

## 原包验证范围

真实样本为作者仓库中的 `@frostgao/dsh-theme-blackgold@1.0.0`，固定 [commit `da5f2bb5e44ff20de469c7bca2ec8427f225c33d`](https://github.com/frostgao/dsh-theme-blackgold/tree/da5f2bb5e44ff20de469c7bca2ec8427f225c33d)。该样本使用包含预构建 `lib/client.js` 的[作者归档](https://codeload.github.com/frostgao/dsh-theme-blackgold/tar.gz/da5f2bb5e44ff20de469c7bca2ec8427f225c33d)，保存为本地 `.tgz` 后安装；包源码和客户端产物未修改。验证时 npm registry 对该包返回 404，因此这里不提供该包的 npm 安装示例。

| 校验对象 | SHA-256 |
| --- | --- |
| 作者归档 | `f6ef545dec6ded0ffaacec8be6ce64026f4b79141888fe5a368f62a632a92957` |
| 原包 `lib/client.js` | `ba0438d0ccfdac090819bf4a88abbfd2b122af8d6a1a3912da5edce19bb03f92` |

macOS 上的 Chromium 浏览器验收在源码模式和仓库外的发行目录均覆盖设置页安装、保存启用选择、重启加载、浅色金色主题、原包品牌槽位、仅内置页面、独立恢复页禁用及重启后恢复内置界面。安装后核对原始 `client.js` 哈希。原包品牌显示 DSH 字样和金色标记，这是插件自身的输出。故障夹具覆盖客户端运行异常、资源丢失和整服务安全模式；这些夹具不算新的第三方兼容样本。

安装弹窗还覆盖直接输入 `https://github.com/frostgao/dsh-theme-blackgold#da5f2bb5e44ff20de469c7bca2ec8427f225c33d` 的原包流程。隔离的 npm 测试源验证不带版本的 scoped 包名和自定义源选择；本机目录测试在安装后删除源目录，再启用和重启，验证使用独立副本。真实 npm 的脚本标记测试覆盖目录包及其 Git 依赖的准备子进程，确认生命周期脚本没有执行。

原包另含依赖具体 SVG 和 DOM 结构的装饰 CSS，上述验收不承诺这些细节在其他页面或版本的表现。Windows、Linux、手机端及其他第三方插件尚未进行同等原包验收；自定义主题选择器和配置持久化仍不属于当前交付。验收使用隔离 Web 数据和模拟 Host，不发起真实模型请求。

相关自动化入口是 [安装与持久化测试](../../packages/web-server/test/ui-extensions.test.ts)、[客户端管理测试](../../tests/dsh/web-ui-extensions.spec.ts)和[浏览器生命周期测试](../../packages/web-server/test/browser/ui-extensions.test.ts)。真实归档测试仅在设置 `CODEXHOST_TEST_DSH_EXTENSION_ARCHIVE` 时执行；真实 GitHub 来源测试通过 `CODEXHOST_TEST_DSH_EXTENSION_GITHUB` 指定上述固定地址。跳过真实来源的结果不能作为原包兼容证据。

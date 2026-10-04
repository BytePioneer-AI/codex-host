# Codex 请求档位

## 使用方式

codexhost 设置 → 通用 →「Codex 请求档位」只有一个开关（默认关闭）；开启后档位在输入框旁的官方模型菜单里选择，不在这里选择。

| 位置 | 行为 |
| --- | --- |
| 设置页开关 | 决定是否在本地强制档位。开启后开关下方给出说明性提示，不弹确认对话框，任何 Host 结果都不阻止继续操作。 |
| 官方模型触发器上的闪电 | 档位生效时，本地 Composer 的官方模型触发器（`data-codex-intelligence-trigger="true"` + `data-composer-navigation-target="reasoning"`）内部、官方 inline 图标槽位（模型名前、14px、间距 4px）显示官方单闪（Fast）/ 双闪（Ultrafast），由样式表按本地展示作用域绘制，不写入官方文本节点或 React 子节点。 |
| 官方模型菜单里的速度按钮 | 打开官方模型菜单后，在官方 `_ViewControls_` 行内、DOM 中紧随官方模型视图切换按钮插入插件自己的 32px 闪电按钮（视觉定位为绝对定位在行的 inline start，与官方 `_FastModeToggle_` 相同；几何 32px 盒 / 26px 内容方块 / 16px 图标；Fast 用官方 `bolt-fill-light-16`，Ultrafast 用官方双闪 `hU`；档位生效时官方 chart-blue 配色）。点击、Enter/Space 或鼠标悬停 200ms（官方 `FlyoutSubmenuItem` 的延时）打开真实的 233px 档位浮层。 |
| 233px 档位浮层 | 与官方 `FlyoutSubmenuItem` 相同：内容渲染在独立 overlay 层（此处为 DOM 原生 `popover="manual"` top layer），因此不会被菜单 `_ViewTrack_` 的 `overflow:clip`、`ModelPickerDropdownContent` 的 `overflow-hidden` 或祖先 transform 裁剪或错位；4px 贴菜单 inline end 展开，空间不足时镜像到另一侧并约束在视口内（RTL 方向对应翻转）。列官方三项（标准 / 快速 / 超快）并带官方描述与 17px 对勾。点「标准」等于关闭本设置。选择后写偏好并触发同步，外层菜单保持打开、仅浮层收起且焦点回到按钮（对应官方 `keepOpenOnSelect`）；重选当前档位同样会上报。 |

档位与官方三档一一对应：**标准** = 关闭（`enabled: false`，请求自带档位时覆写为 `"default"`，否则不注入）、**快速** = Fast、**超快** = Ultrafast。标准项保留上次选择的 Fast / Ultrafast，供重新开启时使用。设置页开关与菜单选择共享同一份偏好，菜单展示最近一次 Host 确认的档位。

滑条粒子是纯装饰：Desktop 自身的运动设置（滑条 Root 的 `data-reduced-motion="true"`）或系统「减少运动」偏好（`prefers-reduced-motion: reduce`）任一成立时都不绘制，两条更严格的访问性门控都保留。

| 本地自定义供应商的下一回合 | `turn/start.params.serviceTierForTurn` |
| --- | --- |
| 关闭 | `"default"`（仅在 Composer 自带档位时覆写，避免残留） |
| Fast | `"priority"` |
| Ultrafast | `"ultrafast"` |

设置与偏好使用 `fast` / `ultrafast` 拼写；`priority` 只出现在出站 Wire 值中。

档位在本地强制发送，不因模型目录是否声明而改变；服务端是否支持、忽略或拒绝由服务端决定。模型目录是否声明只影响设置页的说明性提示（`notice: "notAdvertised"`），不影响出站值。

## 为什么 codexhost 自己画闪电和速度按钮

官方 Composer 的档位控件（`composer.toggleFastMode`「Cycle speed」、Fast / Ultrafast 子菜单、触发器上的 inline bolt）由**账号档位**与**档位数量**共同门控：Desktop 先解析账号认证方式（`chatgpt` / `personalAccessToken`），再要求账号服务返回的 `requirements.featureRequirements.fast_mode !== false`（解包资源中只读核实：`app-initial-*.js` 的 `Iei` → `authMethod==='chatgpt'||'personalAccessToken'` 且 `n.requirements?.featureRequirements?.fast_mode!==!1`，`app-primary-*.js` 的 `_E(Be)` 即 `isServiceTierAllowed`），最后要求 `availableOptions.length > 1`（`Pt = !fe && !ce && Ve && Re.availableOptions.length>1`）。自定义 Provider 通常不满足前两项，因此这些 Thread 上官方控件通常缺席。**需要说明的边界**：`availableOptions` 由 `Iqr(model, serviceTiers)` 从原生 `model/list` 的 `service_tiers` 构建，而 codexhost 启动时会给自定义 Provider 的目录补齐 `priority` / `ultrafast` 两条声明（见下文「原生能力与启动准备」），因此账号侧同时放行时官方控件仍可能出现；这不是「自定义 Provider 永无官方控件」的保证，而是账号门控通常不通过。所以 codexhost 注入前先检测官方控件是否已在同一面板中（`_ViewControls_` / 官方 `FastModeToggle` 片段），命中时让位，避免出现两份速度入口。两处界面都由 codexhost 在官方控件缺席时提供：

- 触发器闪电是一条样式表规则，用官方 20 / 22 单位闪电路径做 mask，尺寸 14px。官方触发器有两种形态，规则用 `:is(...)` 同时覆盖且互斥：带 `_ModelPickerTriggerModelGroup_` 的折叠形态（官方 `_ModelPickerTriggerInlineModeIcon_` 的槽位），以及紧凑形态里模型名所在的 `tabular-nums` 行（后者用 `:not([class*="ModelPickerTriggerModelGroup"] *)` 排除前者子树，保证只有一个匹配元素）。两种形态都是 flex 行，伪元素因此落在模型名之前、继承同一 4px 间距；不依赖官方私有类名哈希，只做片段匹配，且不触碰触发器的文本节点与 React 管理的子节点。
- 菜单里的速度按钮是插件自有的 `button[role="menuitem"]`（`data-codexhost-service-tier-toggle`），几何逐项对齐官方 `_FastModeToggle_`：32px 宽 / 32px 最小高、`position:absolute;inset-inline-start:0` 定在 `_ViewControls_` 行的 inline start、26px 圆角 7px 内容方块、16px 图标（Fast 官方 `bolt-fill-light-16`、Ultrafast 官方 `hU`），配色沿用官方规则（静止 tertiary、档位生效 chart-blue）。按钮刻意不带任何官方类名，避免官方让位检测把自己的控件误判为桌面自带控件；`_ViewControls_:has(...)` 的 16px inline padding 由插件样式补齐，与官方 `:has(._FastModeToggle_)` 行为一致。按钮注入到官方 simple 面板顶行（`_SliderTopRowMotion_`，依次回退到其他 `_ViewControls_`），随该面板 `aria-hidden` / `inert` 或 `data-ultra-warning-visible` 一起消失；官方切到 advanced 模型列表时不会残留。
- 233px 档位浮层是插件自有的 `div[popover="manual"][role="menu"]`（`data-codexhost-service-tier-flyout`），文案与官方 zh-CN / en 逐字一致，对勾用官方 17px 资源画布。它刻意采用 DOM 原生 popover（top layer）：官方 `FlyoutSubmenuItem` 同样把子菜单内容渲染到独立 overlay 层，因为菜单内容自身会裁剪（`_ViewTrack_` 为 `overflow:clip`、`ModelPickerDropdownContent` 带 `overflow-x-hidden overflow-y-hidden` 与 `will-change:transform`），DOM 子节点会被裁掉或错位。浮层用 `position: fixed` 与实测视口坐标定位：4px 贴菜单 inline end，空间不足镜像并约束在视口内（RTL 镜像方向相反）；固定定位使其不受祖先 transform 的包含块影响，也不受菜单自身 overflow 裁剪。定位通过元素的实测视口尺寸与 CSS 布局尺寸换算比例，补偿祖先 CSS `zoom`，并在重定位后按实际浮层边界约束视口内的位置。文档不支持 popover 时整个按钮不注入，宁可不显示也不放在会被裁剪的位置。行项带 `data-interactive="false"`，使官方菜单 capture 阶段的 `[role^="menuitem"]:not([data-disabled]):not([data-interactive="false"])` 键盘走查明确跳过它们：上下 / Home / End / Escape / 方向键由浮层自己处理，Tab 不做 trap（浏览器正常移出，浮层随之关闭）。浮层打开期间才对菜单挂一个局部的 `MutationObserver`（`hidden` / `aria-hidden` / `inert` / `data-ultra-warning-visible` 属性、childList/subtree，范围仅该菜单），一旦面板被桌面隐藏或替换立刻关闭浮层并断开；关闭时同时移除外部 pointerdown / focusin / resize / scroll 监听，重建或 dispose 后旧节点不再上报。

## 作用范围与限制

- 适用于本地 Codex 自定义 Provider，按原生 Thread 的 `modelProvider` 判断；`openai` Provider 的 Thread 保持原生行为（`effect: inactive / officialProvider`）。
- 设置同步始终连接本地 Host，不沿当前远程路由发送。远程 Thread 和其他 Harness 的 Thread 不应用此设置；外部 Harness 在进入官方请求转发前已由各自 Adapter 接管。展示按每个已挂载 Composer 的 `hostId === "local"`、当前 Agent 和切换状态判断，不使用全局当前路由代替。只有本地原生 Codex Composer 及其官方菜单获得 `data-codexhost-service-tier-scope="fast|ultrafast"`；菜单即使以 portal 挂载在 Composer 之外，也由对应控件管理作用域。远程或外部 Composer 不显示本地档位闪电、速度按钮或滑条粒子。
- 展示作用域由控件生命周期管理：原生草稿在同一 Composer 内切换 Host 时立即刷新，不等待模型目录或全局路由变化；触发器或菜单替换，以及卸载时清理旧标记。相同档位不重复写 DOM。`<html>` 上的已确认状态不直接作为 CSS 作用域。
- 闪电与速度按钮只在设置开关开启、当前是本机原生 Codex Composer，且最近一次结果是 `active`（含带 `notAdvertised` 提示）时出现；`officialProvider`、`off`、失败或未连接时移除。按钮只在官方模型菜单打开时存在（按触发器的 `aria-controls` 定位），菜单关闭、菜单被官方重建、切换 Agent 或卸载时都会移除并可在重建后恢复；顶层 popover 不可用时按钮不注入。选择写偏好并触发同步（重选当前档位也会上报，与官方行一致），展示的是已确认档位，不是草稿选择。
- 原生 Codex 必须支持 `serviceTierForTurn` 与自定义模型目录。模型目录在原生进程启动时加载，运行中更换 Provider、模型目录或 Codex 版本不保证获得新能力；切换本设置本身不会重启进程。
- 本功能不解锁 Desktop 自带的档位选择器，不修改官方应用文件，也不改写用户原始 `config.toml` 或模型目录文件。闪电用官方闪电路径按 mask 绘制在官方 inline 图标槽位；速度按钮与 233px 浮层是插件自有节点，注入位置为官方 simple 面板顶行（`_SliderTopRowMotion_` 下的 `_ViewControls_`），不修改官方菜单的既有行与 React 管理的节点；同一菜单里检测到官方 `_FastModeToggle_` 时让位，不并排出现两份速度入口。浮层是 `popover="manual"` 的 top layer 节点，视觉上脱离菜单裁剪上下文，但仍留在菜单 DOM 子树内，因此外部点击判定与官方菜单自身的 dismissal 语义不变；浮层打开期间对菜单的可见性属性挂局部 observer，面板被隐藏或替换时立即关闭。
- max-power（purple）：官方 `_FastModeToggle_` 依据 `data-max-power-selection` 从 chart-blue 变 chart-purple，该状态由官方推理档位（`reasoningEffort: "ultra"` / `isMaximum`）派生。codexhost 的速度按钮不持有官方推理档位状态，也没有独立可靠来源判断「最大功率」，因此按钮只在档位生效时使用官方 chart-blue，不伪造 purple 状态（可验证限制：若未来官方在可读 DOM 上暴露 `data-max-power-selection`，可再派生该配色）。

## 原生能力与启动准备

Codex 会检查模型目录里的 `service_tiers`，并可能因未声明而改写或省略出站档位，因此只修改界面不足以保证实际行为；本实现同时在本地强制 `serviceTierForTurn`。

`prepareCodexServiceTierCatalog` 在本地原生后端启动前准备目录：

1. 读取 `<CODEX_HOME>/config.toml`，并按 Codex CLI 语义应用 `-c key=value` 覆盖：仅在第一个 `=` 处切分，key 按 `.` 分段且**不**当作 TOML 解析（因此 `plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true` 这类真实 Desktop 参数合法），value 按 TOML 值解析，失败则当字面字符串；只提取 `model_provider` / `model_catalog_json` / `profile` / `profiles` 相关值，无关或畸形覆盖被跳过而不影响启动。
2. 仅当生效的 Provider 不是 `openai` 时准备目录：配置了 `model_catalog_json` 就读取并扩展其副本（相对路径以 `CODEX_HOME` 为基准），否则从实际启动的 Codex 可执行文件提取内嵌模型元数据；只为每个模型补齐缺少的 `priority` 与 `ultrafast` 声明，其余字段的值保留。
3. 将内容寻址的 JSON 副本写入 `<CODEX_HOME>/codexhost/service-tier-catalogs/<sha256>.json`，通过 `-c model_catalog_json=...` 追加到原生后端参数。

原始配置及目录不变；读取、解析或写入失败时保留原生启动参数，不阻止 Codex 启动。

## 设置与请求路径

Renderer 偏好保存在 `localStorage["codexhost.codex-service-tier.v1"]`，内容为 `{ enabled, tier }`。同步器通过 `codexhost/settings/codex-service-tier/set` 提交给本地 Host；未连接或断开时显示同步中，Host 不支持该方法时显示不支持，提交失败时显示失败；这三种情况都不标记为已生效，也不显示闪电与速度按钮。

Host 返回 `{ settings, effect }`：`effect` 为 `off`、`active`（可选 `notice: "notAdvertised"`），或 `inactive` 并附 `reason: "officialProvider"`。设置非法返回 `-32602`；原生读取失败返回 `-32000` 且保留之前已确认的设置。`active` 时 Renderer 在 `<html>` 写入 `data-codexhost-service-tier="fast|ultrafast"`，其他情况移除该属性；它只表示本地 Host 已确认的状态，展示由各个 Composer 派生到自己的作用域。设置页按此渲染状态 pill 与信息提示（生效、未声明档位、官方 Provider、同步失败/不支持），全部为信息性，不阻断开关。

`OfficialRuntimeScope` 中的 `CodexServiceTierControl` 由同一 native runtime 的所有客户端共享，串行处理修改，并被动缓存每个 Thread 的 Provider（上限 512）；进程退出时 `reset()`。

在最终官方 `turn/start` 转发处，Host 等待已排队的设置修改，读取 Thread 的原生 Provider，对自定义 Provider 设置 `serviceTierForTurn`：关闭且请求未带档位时原样转发；关闭但请求自带档位时写 `"default"`；开启时写 `"priority"` / `"ultrafast"`。缓存命中零次 native 往返，未命中最多一次 `thread/read`。`turn/steer` 不修改；Host 不设置 sticky 的 `serviceTier`，并保留待转发请求的其他字段。该局部改写是[官方流量归属](../architecture/official-traffic-ownership.md)的明确例外：不改变官方请求归属，不提前严格校验未知官方参数；无需覆写时走原帧转发路径，转发后保留请求回复保护。

## 验证

定向测试覆盖以下行为；测试执行结果由对应验证运行报告，不在功能文档中维护会话记录：

- `packages/host-runtime/test/app-server-host.codex-service-tier.test.ts`：同一 Thread 的 Fast、Ultrafast、默认与再次 Fast，旧 Composer 参数覆写，原请求不被原地修改，观察缓存，未声明档位仍强制注入，openai 与已开启设置下的外部 Harness 隔离，失败保留已接受设置，Host RPC 与最终转发；开启时未知官方参数仍透传给原生校验，`turn/steer` 不改写。
- `packages/host-runtime/test/codex-service-tier-catalog.test.ts`：UTF-8 模型元数据提取、档位不重复、用户目录保留、profile 与命令行覆盖、**带 `@` 的真实 Desktop 参数回归**（`plugins.codex-app-tools@openai-bundled...`）、畸形覆盖跳过、启动失败回退。
- `packages/renderer-extension/test/renderer-codex-service-tier-preference.test.ts`：偏好校验与存储回退、重连与过期结果丢弃、快速修改合并、Host 不支持或拒绝时不标记已生效，以及 `<html>` 标记只在确认 `active` 时镜像（含 `notAdvertised`）。
- `packages/renderer-extension/test/renderer-codex-service-tier-bolt.test.ts`：用官方菜单 DOM 结构（`role="menu"` + `aria-controls` 指向 + `_ModelPickerDropdownContent_` + `_ViewTrack_` + `_ViewControls_`）覆盖 32px 按钮紧跟官方视图切换、官方三档顺序与文案、官方 17px 对勾、选中态、标准项回调 `null`、重选当前档位仍上报、Hover 200ms 后 click 的竞争、Escape / 方向键 / Home / End / Tab 行为与焦点回收、外部 pointerdown / focusin 关闭、菜单可见性 observer 关闭浮层、菜单关闭/重建/外部 Harness/触发器缺失/超快警告/顶层 popover 不可用时移除、dispose 清理与旧节点不再上报、重复渲染零 DOM 写入、RTL 与视口边缘的浮层定位、en/zh 官方文案；另覆盖本地展示判定、root 与 portal 作用域建立/清理，以及同一 Composer 重建菜单时释放旧 portal。
- `packages/renderer-extension/test/renderer-binding-probe-host-catalog.test.ts`：通过实际 probe 的渲染调用验证 per-Composer Host 与全局路由不一致时的本地隔离，以及同一原生草稿在全局路由不变时从本地切到远程、再回本地的即时刷新。
- `packages/renderer-extension/test/settings/codex-service-tier-controls.test.ts`：设置页只有开关（无档位选择、无对话框），提示随 effect 变化，不同步阻断开关。
- `packages/renderer-extension/test/renderer-codex-service-tier-style.test.ts`：粒子和触发器闪电样式限定在控件管理的本地作用域，不以全局 `<html>` 状态直接键控；保留官方滑条标识、两项 reduced motion 门控、官方 inline 图标组片段与闪电路径 mask；速度按钮 32px / 26px / 16px 几何、官方 chart-blue enabled 色与 `_ViewControls_` 16px inline padding、233px popover 浮层与 `:not(:popover-open)`、17px 对勾，并断言旧 row/list/panel 规则已不存在。
- `tests/e2e/renderer-codex-service-tier.spec.ts`：浏览器中的开关、状态 pill、信息提示、触发器闪电（computed style）、速度按钮注入与官方键盘 capture 交互、233px 浮层在真实裁剪/变换和 125% CSS zoom 下的可见性与定位、档位选择与写偏好、标准档回退关闭开关、菜单关闭/重建后的恢复、外部行为与卸载后的官方菜单完整性；同页旁置本地/远程 Composer 与 menu portal，验证 Fast/Ultrafast 的闪电和粒子只出现在本地，且全局路由变化不影响各 Composer 的归属判定。

原生链路验证使用独立临时 `CODEX_HOME` 与本地模拟 Responses Provider，观察 `prepareLocalCodex` → `AppServerHost` → 原生 Codex → HTTP 请求的档位字段。目录与启动覆盖测试另行覆盖带 `@` 的 Desktop 参数、profile 和畸形覆盖的回退行为；这些验证不等同于真实 Provider 的速度、计费或服务端支持验证。

## ADDED Requirements

### Requirement: 设置壳提供双端共用的委派设置页
codexhost 设置壳 SHALL 提供一个在 Codex Desktop 与独立 Web 设置中共用的「多 Agent 协作」页面（id 为 `delegation`），用于展示多 Agent 委派回流示意图、`#` 唤起示例，以及为本机已就绪的 Harness 配置被委派时的默认模型与思考强度。

#### Scenario: 首屏仅展示本机已就绪的可配置 Agent 且不触发全量模型探测
- **WHEN** 用户打开「多 Agent 协作」设置页
- **THEN** 页面 SHALL 复用既有本地连接状态缓存，仅展示内置 Codex 与本机已就绪的 Harness 及其已保存的委派默认状态
- **AND** 页面 MUST NOT 在首屏并发调用所有 Harness 的完整模型目录探测，也不展示无法选择模型的未安装或未就绪项

#### Scenario: 展开下拉时按需加载模型与思考强度
- **WHEN** 用户在某个 Agent 行交互以选择委派默认模型或思考强度
- **THEN** 页面 SHALL 按需对该 Harness 执行一次目录读取并展示其可用模型与该模型支持的思考强度选项
- **AND** 当目标 Harness 不支持思考强度选择或当前模型无可用档位时，页面 SHALL 隐藏思考强度选择器

#### Scenario: 保存、重置与双端同步
- **WHEN** 用户在 Desktop 或 Web 设置页修改或重置某个 Harness 的委派默认模型或思考强度
- **THEN** 变更 SHALL 持久化到共享 Harness 偏好并同步到另一端
- **AND** 顶部流程图与行内生效状态 SHALL 反映最新配置，未覆盖时显示「跟随 Agent 默认」

#### Scenario: 响应式布局随设置内容区宽度切换
- **WHEN** 设置内容区处于宽屏或窄屏宽度
- **THEN** 页面 SHALL 依据设置内容区容器宽度切换横向与竖向委派流程图布局，且在窄屏下不出现横向滚动溢出

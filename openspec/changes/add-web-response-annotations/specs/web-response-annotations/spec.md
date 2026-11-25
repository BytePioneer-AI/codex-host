## Purpose

让 Web 用户把回复中选中的文字挂到下一条消息上，并让同一 Thread 无论从 Desktop 还是 Web 发送，消息文本与历史呈现都一致。

## ADDED Requirements

### Requirement: 回复中的选中文字可附加为批注

Web SHALL 允许用户在已完成的回复中选中文字，并在选区旁提供「Add to chat」；选择后 SHALL 把该段文字挂到当前 Composer，按选择顺序排列，可逐条移除，不影响草稿正文与其他附件。选区文字 SHALL 按 Codex Desktop 自己的选区提取规则保留段落、换行、表格与列表边界：列表只保留条目文字，不写 Web 自造的标记或编号。

#### Scenario: 在一条已完成的回复中附加批注

- **WHEN** 用户在某条已完成回复内选中一段文字并选择「Add to chat」
- **THEN** 该段文字 SHALL 出现在 Composer 上方的批注芯片中，序号从 1 开始
- **AND** 已有草稿、附件与光标位置 SHALL 保持不变，且不发送消息

#### Scenario: 跨段落与列表的选区

- **WHEN** 用户选中的文字跨两个段落，或落在列表上
- **THEN** 附加的文字 SHALL 与 Desktop 对同一选区提取的结果相同

#### Scenario: 多条批注与移除

- **WHEN** 用户先后附加多段文字后移除其中一条
- **THEN** 剩余批注 SHALL 保持原有相对顺序并重新连续编号
- **AND** 移除 SHALL 只影响该条批注，不影响草稿正文

#### Scenario: 入口的位置

- **WHEN** 入口出现
- **THEN** 桌面视口 SHALL 把它画在选区上方，右缘与选区右缘对齐，并按自身宽度收到视口内
- **AND** 触摸视口 SHALL 把它放在选区下方，让系统自带的选区菜单留在上方可用

#### Scenario: 不适用于其他状态

- **WHEN** 选区落在两条回复之间、落在回复内的代码块控件或可编辑区域内，或回复仍在流式生成
- **THEN** Web MUST NOT 提供该入口

### Requirement: 批注随消息按 Desktop 格式发送

发送含批注的消息时，Web SHALL 在正文前生成 Codex Desktop 的批注前缀区块，以其后紧跟请求分隔段的形式一并交给 Harness；只有批注而没有正文的消息 SHALL 同样可发送。正文只去掉首尾空白；组成消息的其余部分 MUST 原样保留。批注条目 SHALL 省略原生格式中可选的 `source` 定位字段。

#### Scenario: 同时有批注与正文

- **WHEN** 用户附加一段批注并输入正文后发送
- **THEN** 发给 Harness 的消息文本 SHALL 依次为批注区块、请求分隔段与正文
- **AND** 对相同的条目与正文，该文本 MUST 与 Codex Desktop 拼装的结果逐字节相同，包括标点与结尾换行

#### Scenario: 只有批注

- **WHEN** 用户只附加批注、未输入正文就发送，包括用发送按钮发送
- **THEN** 消息 SHALL 照常发出，正文部分为空
- **AND** 发送成功后该批注 SHALL 从 Composer 移除

#### Scenario: 发送失败

- **WHEN** 发送被拒绝或失败
- **THEN** 该批注与正文 SHALL 按发送尝试的先后一并回到 Composer 供再次发送
- **AND** 用户已经移除的批注 MUST NOT 因此重新出现

### Requirement: 已发送消息只显示正文与批注

已发送的用户消息 SHALL 只显示正文，批注区块 MUST NOT 作为原始文本出现在消息中；该消息附带的批注 SHALL 以编号芯片显示，可点开查看完整选中文字。正文与芯片 SHALL 由记录下来的这条消息文本本身得出。

#### Scenario: 重新打开历史

- **WHEN** 用户重新打开包含批注消息的历史，或刷新页面
- **THEN** 该消息 SHALL 只显示正文并以芯片显示各条批注
- **AND** 显示的批注 SHALL 与该消息发送时的内容一致

### Requirement: 回复中的批注引用可展开

回复以原生指令 `:codex-annotation{index="N"}` 引用批注时，Web SHALL 在 Markdown 语法层识别它并显示为「批注 N」标签，点击或轻点后可查看对应选中文字。行内代码、代码块与转义示例 MUST 保持原文。序号只接受正规的十进制正整数；被识别为指令但序号不合规或找不到对应批注时 SHALL 不显示任何内容。

#### Scenario: 引用能对应到批注

- **WHEN** 回复正文里的指令序号对应该 Turn 用户消息中附加的批注
- **THEN** Web SHALL 显示「批注 N」标签，并能展开显示该批注的选中文字
- **AND** 回复仍在流式生成时 SHALL 与生成结束后显示同一个标签

#### Scenario: 引用无对应批注

- **WHEN** 指令序号找不到对应批注，或序号不是正规的正整数
- **THEN** Web SHALL 不显示标签，也不显示指令原文

#### Scenario: 代码与转义

- **WHEN** 同样的文字出现在行内代码、代码块中，或冒号被反斜杠转义
- **THEN** Web SHALL 原样显示该文字

#### Scenario: 链接文字里的指令

- **WHEN** 指令出现在链接文字中
- **THEN** Web SHALL 保留该位置的标签文字，且不在链接内嵌套交互控件

#### Scenario: 属性边界与引号内空白

- **WHEN** 指令使用 `index=1 extra="x"`，或 `index=" 1"`
- **THEN** 前者 SHALL 引用批注 1，后者 SHALL 因序号不合规而不显示内容
- **AND** 属性间的 Tab SHALL 作为分隔符，引号内的 Tab 与空格 SHALL 保留为属性值

#### Scenario: 跨行的属性块

- **WHEN** 指令的属性块包含 CRLF、LF 或 CR
- **THEN** Web SHALL 继续显示其余 Markdown 正文，不产生批注引用或解析异常

#### Scenario: 指令自身带可选标签

- **WHEN** 回复使用 `:codex-annotation[explanation]{index="1"}` 引用批注
- **THEN** Web SHALL 显示批注 1 的标签，并可展开对应选中文字
- **AND** 指令自身的标签与属性语法 MUST NOT 残留为正文

#### Scenario: 连续属性片段

- **WHEN** 回复使用 `:codex-annotation{index="1"}{ index="2"} tail`
- **THEN** Web SHALL 按原生属性词法选择批注 2，并保留后面的正文 ` tail`
- **AND** 若第二个片段改为 `{index="2"}`，Web SHALL 沿用原生取值规则选择批注 1

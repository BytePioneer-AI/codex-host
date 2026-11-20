## ADDED Requirements

### Requirement: 用户可以在回复选区旁写批注

Web SHALL 在已完成回复的有效选区旁提供「添加批注」，打开与选区关联的多行编辑框。确认非空批注后，Web SHALL 将选中文字与批注一起附到当前 Composer，保留已有正文与附件，并将输入焦点移至 Composer。取消 SHALL 关闭编辑框。

#### Scenario: 输入并确认批注

- **WHEN** 用户在已完成回复中选中文字、点击「添加批注」并确认批注
- **THEN** Composer SHALL 新增一条批注，可展开查看所选原文和批注内容
- **AND** 消息 SHALL 等待用户从 Composer 提交

#### Scenario: 取消或输入空白

- **WHEN** 用户取消编辑，或批注只含空白
- **THEN** Web SHALL 保持 Composer 的批注列表不变

### Requirement: 草稿批注与所选原文关联

Web SHALL 在未发送批注的原文处高亮选区，并显示可点开查看批注的编号。编号 SHALL 对应当前 Composer 中的位置。点击有原文定位的草稿引用时，Web SHALL 让选区第一行对齐聊天视口从顶部算起的 30%，并受可滚动范围限制。移除批注 SHALL 清除对应高亮和编号。批注随消息发送时 SHALL 使用既有的批注格式。已发送消息 SHALL 继续通过批注芯片提供原文和批注的历史记录。

#### Scenario: 原文包含相同文字

- **WHEN** 同一回复有多个相同片段，用户批注其中一个
- **THEN** Web SHALL 在实际选中的片段处显示来源标记

#### Scenario: 发送失败恢复草稿

- **WHEN** 发送失败且批注回到 Composer
- **THEN** 在原文仍可定位时，Web SHALL 恢复对应的高亮和编号

#### Scenario: 从草稿引用跳回原文

- **WHEN** 用户从已完成回复中添加引用或批注，之后点击 Composer 中的对应芯片
- **THEN** Web SHALL 将实际选中片段的首行滚动到聊天视口的 30% 位置，或滚动范围内最接近该位置的落点
- **AND** 芯片 SHALL 保持可查看原文和批注

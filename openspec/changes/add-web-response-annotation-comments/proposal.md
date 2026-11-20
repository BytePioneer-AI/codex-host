# Proposal

## Why

Web 可以将回复选区附到 Composer。需要针对某一段内容提出问题时，用户还需要在选区旁写下批注，并从原文找到它。

## What Changes

- 在已完成回复的选区旁提供「添加批注」，打开就地输入框。确认后将所选文字和批注一起附到当前 Composer。
- 在有草稿批注的原文高亮对应选区，并提供可展开的编号标记。批注随下次消息一起发送。
- 点击 Composer 中的草稿引用时，滚动到所选原文。

## Decisions

- 原文定位属于当前 Web Composer 的草稿。已发送消息继续通过批注芯片呈现历史记录，发送文本沿用现有批注格式。

## Capabilities

### Modified Capabilities

- `web-response-annotations`（由 `add-web-response-annotations` 定义）增加就地输入和草稿原文标记。

## Impact

涉及 Web 聊天视图、Composer 草稿状态和 Web 功能文档。

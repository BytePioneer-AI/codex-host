# Proposal

## Why

手机照片通常有数 MiB，经远程中转上传时占用主要带宽。选择后自动压缩大照片可以缩短发送等待，同时保留现有附件体验。

## What Changes

- JPEG、WebP 长边超过 2048 像素或大小超过 1 MiB 时，在上传前按方向转正、等比缩小并尝试输出质量 0.85 的 JPEG。
- 只采用更小的结果；不支持、解码或编码失败时上传原文件。PNG、GIF、普通文件不变。
- 压缩属于现有上传过程，重试复用准备结果，不新增状态、设置或文案。

## Decisions

- 不提供原图开关；接受压缩移除 EXIF（包括 GPS）。文件名主体保留，采用压缩结果时改用 `.jpg` 和 `image/jpeg`。
- 服务端校验、附件提交与重试语义保持不变。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `web-attachment-submission`：增加浏览器大照片压缩与失败回退，调整图片预上传的原始二进制要求。

## Impact

仅涉及 Web 图片附件上传客户端、其测试和该能力的规格增量；无新增包、依赖或服务端协议变更。

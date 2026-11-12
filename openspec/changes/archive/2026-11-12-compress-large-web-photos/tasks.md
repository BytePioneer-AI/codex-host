# Tasks

## 1. 浏览器照片准备

- [x] 1.1 实现独立照片准备模块并接入现有上传队列，复用结果且保留取消与重试；用聚焦 vitest 验证准备期间发送、取消和重试。
- [x] 1.2 添加真实 Chromium 测试覆盖尺寸、EXIF 方向、小图、PNG/GIF、WebP、失败与变大回退、上传 MIME 和重试复用，并记录合成照片压缩字节、尺寸及耗时。

## 2. 验证

- [x] 2.1 运行指定附件浏览器与 vitest 回归、typecheck、lint、改动文件 prettier 和 openspec validate --all，记录实际结果，不归档、不提交、不重启用户服务。

## 验证记录

- 新增 Chromium 测试 2/2 通过，覆盖 15 个准备场景和真实上传的 MIME、字节、重试与解码失败回退；指定浏览器附件回归 6/6 通过。
- 新增照片上传 vitest 6/6、附件发送 10/10 通过。附件进度测试 2/4 通过；两项失败期待图片缩略图显示完整上传文案，实际为百分比。同样失败已在 HEAD 的临时源码副本重现，未修改既有 UI 或断言。
- typecheck、lint、全部改动文件 prettier（包含默认忽略的 Markdown）、openspec validate --all 通过。全量 OpenSpec 存在其他能力的既有警告，无失败。
- 浏览器测试使用临时输出的独立客户端构建、临时数据目录、随机回环端口、真实 Chromium 与 fixture Host；未调用真实 Harness 或模型，未重启用户 Web/Host。

# Tasks

行为验收见 [spec](specs/local-design-preview/spec.md)。与前三个变更无依赖，可以并行。

## 1. 预览服务

- [x] 1.1 只读静态服务器：根目录限定、工作目录校验、路径穿越与符号链接检查、仅 loopback、无目录列表。验证：越界与穿越用例被拒；相对资源可以加载；非 GET 请求返回 405。
- [x] 1.2 文件监听与刷新：只向 HTML 响应注入刷新脚本，300 毫秒合并。验证：修改 HTML、CSS 与新增图片后 1 秒内刷新；连续写入只刷新一次；非 HTML 响应内容不变。

## 2. 打开与生命周期

- [x] 2.1 `preview open|list|show|close` 与控制路由，复用现有本地页面通道打开内置浏览器标签；同一文件复用。验证：单元测试覆盖打开、复用、标签关闭后重开（已完成）；真实 Desktop 中的打开与切到前台并入 3.2。
- [x] 2.2 回退与不支持：没有可见本地任务或内置浏览器时改用系统浏览器；受管远程 Host 返回 `UNSUPPORTED`。验证：分别模拟三种情况并检查返回字段。
- [x] 2.3 生命周期：Thread 归档与 Runtime 退出时关闭；超出上限时关闭最久未用的预览。验证：归档后 URL 不可访问；退出后端口释放。

## 3. 文档与验收

- [x] 3.1 更新委派帮助文本（`preview open|list|show|close`）、`docs/architecture/local-design-preview.md` 与 `docs/index.md`。“设计稿用 preview 打开”的建议写进 spec-design skill，由使用方维护。验证：CLI 测试。
- [x] 3.2 真实验收：在 Claude Code Thread 中生成一个多页 HTML 原型，用 `preview open` 打开，连续修改三轮并确认自动刷新；在原生 Codex Thread 中重复一次。记录平台与 Desktop 版本。

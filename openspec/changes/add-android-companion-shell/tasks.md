# Tasks

## 1. Android 工程脚手架与核心领域模型

- [x] 1.1 创建 `apps/android-shell/` 纯 Kotlin Android 工程（Gradle Kotlin DSL、Gradle Wrapper 脚本/配置、`minSdk 26` / `targetSdk 35`、无 GMS 依赖），实现链接/Token 解析、私网 HTTP 安全校验与主机存储模型。验证：纯 JVM 单元测试覆盖 URL/Token 解析与私网/公网 HTTP 拒绝规则。

## 2. 配对认证、安全存储与多主机列表

- [x] 2.1 实现基于 Android Keystore `EncryptedSharedPreferences` 的多主机凭据存储、CameraX + ZXing 扫码配对页面（含手动粘贴链接）、`POST /api/auth/login` 校验与 Cookie 同步、主机列表管理页面及 GitHub Releases 更新检查。验证：核心状态机与凭据/Cookie 解析逻辑通过 JVM 单元测试。

## 3. 受控全屏 WebView 容器与 CI 流水线

- [x] 3.1 实现全屏 WebView 容器（`WindowInsetsCompat` 键盘与安全区贴合、返回键路由、`onShowFileChooser` 原生文件与拍照上传、同源限制与外链系统浏览器跳转、401 失效提示、离线重连与切机卡片）。验证：检查 Manifest 权限、FileProvider、network_security_config 与生命周期清理无遗漏。
- [x] 3.2 新增 `.github/workflows/android-apk.yml` 完成单元测试与 APK 构建上传。验证：YAML 语法有效且 Gradle 任务名与工程模块一致。

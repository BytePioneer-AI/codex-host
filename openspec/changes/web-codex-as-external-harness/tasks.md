# Tasks

估时按一人计，合计约 7–10 人日。

## 1. Codex CLI 作为外部 Harness 接入（1–1.5 天）

- [x] 1.1 目录、包名、manifest 改为 `codex-cli` 并声明 `surfaces: ["web"]`，加入预装列表。验证：插件构建、`npm run lint` 的边界检查通过，Host 加载诊断中出现 `codex-cli`。
- [x] 1.2 可执行文件改用通用发现与 launch settings，保留 shim 拒绝，删除 `codexHome` locator 与强制 `--codex-command`。验证：未安装、解析到 shim、正常三种检查结果的单元测试。
- [x] 1.3 未选权限模式时不下发审批与沙箱参数，删除写死的 `sandboxPolicy`。验证：Adapter 测试断言 `thread/start`、`turn/start` 的参数。
- [x] 1.4 在共享 Host 外部运行时中跑通新建、Turn、取消、审批、提问、导入、恢复。验证：外部运行时集成测试使用模拟 app-server 覆盖以上流程。

## 2. 插件界面声明与 Desktop 过滤（1.5–2.5 天）

- [x] 2.1 manifest schema 加 `surfaces`，非法值拒绝加载并给出诊断。验证：shared-contracts 与 Loader 测试覆盖未声明、仅 Web、非法三种情况。
- [x] 2.2 Desktop 侧过滤插件列表、新建路由、Thread 列表、Thread 事件。验证：每个过滤点一条回归测试，同时断言 client channel 侧不受影响。
- [x] 2.3 委派在父 Thread 为 official 时排除仅 Web 的 Harness。验证：委派测试覆盖 official 列出、official 创建被拒、external 创建成功。

## 3. 删除隔离 Web Codex 来源（2–3 天）

- [x] 3.1 Web 只组装 `ChSessions`，删除 Mixed、Remote、SourceEndpoints 及 `main.ts` 的 Codex 参数与分支，删除 `workspaces` 的 local organization 分支与 codexScope。验证：web-server 类型检查与现有 Web 测试通过，Codex CLI 出现在 Web 的 Harness 列表。
- [x] 3.2 删除 Host owner、`/v1/web-codex/*`、`web-codex-changed` 事件、desktop-control 调用、`web-codex` 插件 scope 与偏好 scope。验证：`grep` 不再命中 `webCodex`、`web-codex`、`WebCodex`；类型检查通过。
- [x] 3.3 删除 `IsolatedSessions`、组织与数据存储，以及契约中的 `steer?`、`readHistory?`。验证：session-runtime 只剩共用模块；`npm run typecheck`、`npm run lint` 通过。
- [x] 3.4 删除对应测试文件与两个被取代的 change 目录。验证：测试套件通过，`openspec validate --strict` 通过。

## 4. 验证与文档（2–3 天）

- [ ] 4.1 Web 实机：用本地 Codex CLI 新建会话、发送、审批、取消、导入原生会话，关闭 Web 网关后任务继续。验证：记录操作与结果。**（待用户实机验证）**
- [ ] 4.2 GUI 实机：Desktop 选择器、会话列表、委派中都看不到 Codex CLI；官方 Codex 新建与对话正常。验证：记录操作与结果。**（待用户实机验证）**
- [x] 4.3 更新 `gui-web-shared-state-design.md`、`host-client-channel.md`、`standalone-web.md`、`packages/web-server/README.md`，说明 Codex CLI 是普通外部 Harness，并注明同一原生会话不要在 GUI 与 Web 同时打开。验证：文档中不再描述隔离 Web Codex 来源。

## 验证记录

命令均在本 worktree 根目录运行。基线（改动前）已存在两处与本变更无关的失败，单独列出，避免误判。

### 阶段 1（1.1–1.4）

- `npm run build:plugins`：通过。产物包含 `packages/host-runtime/dist/plugins/codex-cli/manifest.json`（`id: codex-cli`、`name: Codex CLI`、`surfaces: ["web"]`）。
- `node --input-type=module -e "loadHarnessPlugins(dist/plugins, external)"`：`loaded codex-cli: true`，诊断为空。
- `npx vitest run --config tests/vitest.config.js packages/adapters/codex-cli`：4 个文件、20 个测试通过（含未安装、shim/代理拒绝、正常解析、权限参数、进程与环境隔离）。
- `npx vitest run --config tests/vitest.config.js packages/host-runtime/test/codex-cli-harness.test.ts`：1 个测试通过（新建、审批、提问、取消、导入、恢复经外部 Thread 运行时）。
- `npx vitest run --config tests/vitest.config.js packages/adapters/codex`：12 个文件、89 个测试通过、1 个跳过（共享 `tests/fixtures/codex-auth-peer.cjs` 的回归）。
- `npx tsc -b packages/adapters/codex-cli/tsconfig.json` 与 `npx tsc -b packages/host-runtime/tsconfig.json`：通过。
- `npm run typecheck`：除基线已有的 `packages/web-server/test/harness-preferences.test.ts:112` 外无新增错误。
- `npx eslint`（限本阶段改动文件）与 `node tools/check-boundaries.mjs`：通过。`npm run lint` 的失败项均为基线或工作区外部文件（`.work/otter-installer/source`、`external-thread-queue.ts`、既有 browser 测试、会话期间由其它进程新建的 `tests/dsh/`），本变更未新增。

### 阶段 2（2.1–2.3）

- `npx vitest run --config tests/vitest.config.js packages/shared-contracts/test/harness-plugins.test.ts`：38 个测试通过（未声明、仅 Web、非法 `surfaces`）。
- `npx vitest run --config tests/vitest.config.js packages/host-runtime/test/harness-plugin-loader.test.ts`：52 个测试通过（插件声明被记录；空或未知取值以 `invalidManifest` 拒绝加载）。
- `npx vitest run --config tests/vitest.config.js packages/host-runtime/test/desktop-harness-surfaces.test.ts`：2 个测试通过（Desktop 插件列表、新建拒绝、Thread 列表、Thread 事件四个过滤点，且 client channel 侧不受影响；official 父 Thread 的列出、检查、创建均排除仅 Web，external 父 Thread 可创建）。
- `npx vitest run --config tests/vitest.config.js packages/host-runtime/test`：121 个文件、1121 个测试通过、7 个跳过（首次运行暴露 `installed-harness-plugins.test.ts` 的预装清单期望需要加入 `codex-cli`，已同步后复跑通过）。
- `npm run typecheck`：除基线已有的 `harness-preferences.test.ts:112` 外无新增错误。
- `npx eslint`（限阶段 2 改动文件）通过；`node tools/check-boundaries.mjs` 通过。`npm run lint` 仍只有基线/工作区外部文件的 21 个错误。

### 阶段 3（3.1–3.4）

- `npm run typecheck`：通过（此前基线中的 `harness-preferences.test.ts:112` 也随 `decorate` 失败分支类型补齐而消失）。
- `cd packages/web-server && node --import tsx --test test/*.test.ts`：184 个测试通过（3.1、3.2、3.3 后各复跑一次；期间修正了 `workspaces` 的 pin/archive 投影语义，并删除只服务隔离来源的测试与插件目录）。
- `npx vitest run --config tests/vitest.config.js packages/host-runtime/test`：112 个文件、1105 个测试通过、7 个跳过；其中 `codex-cli-harness.test.ts` 在 2.x 的 Desktop 过滤生效后改为经 client channel 走新建、审批、提问、取消、导入与恢复。
- `npx vitest run --config tests/vitest.config.js packages/host-runtime/test packages/shared-contracts/test packages/harness-plugin-files/test packages/desktop-control packages/adapters/codex-cli`：163 个文件、1464 个测试通过、7 个跳过。
- `grep -rn "webCodex\|web-codex\|WebCodex" packages scripts tools`：生产代码无命中（仅剩 `harness-plugin-files/test/preferences.test.ts` 的负向断言）；`IsolatedSessions`、组织存储与数据存储不再存在。
- `grep -rn "steer?\|readHistory?" packages/harness-adapter/src`：无命中；Host Loader 的可选能力检查只剩 `credits`、`refreshCredits`。
- `npx openspec validate web-codex-as-external-harness --strict`：`Change 'web-codex-as-external-harness' is valid`。
- `git diff --check`：无输出（无空白错误）。
- `npm run lint`：21 个错误全部来自工作区外部或既有文件（`.work/` 副本、`external-thread-queue.ts`、既有 browser 测试、会话期间其它进程新建的 `tests/dsh/`）；本次改动文件用 `npx eslint` 单独检查通过，`node tools/check-boundaries.mjs` 通过。

### 阶段 4（4.1–4.3）

- 4.1、4.2 需要用户在真实 Desktop/Web 上操作，本轮未执行，已在任务上标注“待用户实机验证”。
- 4.3 `grep -rn "隔离 Web Codex\|隔离 Codex 来源\|isolated Web" docs packages/web-server/README.md --include=*.md`：无命中；`grep -rn "web-codex" docs` 仅保留“旧数据不读取/迁移”的说明。
- 更新了 `docs/architecture/gui-web-shared-state-design.md`、`docs/architecture/host-client-channel.md`、`docs/architecture/harness-plugin-runtime.md`、`docs/product/standalone-web.md`、`docs/product/usage-statistics.md`、`docs/index.md` 与 `packages/web-server/README.md`，均说明 Codex CLI 是普通外部 Harness、仅 Web 呈现，并注明同一原生会话不要在 GUI 与 Web 同时打开。

### 最终验证

- `npm run build:plugins`：通过，预装目录含 `codex-cli`，不再生成 `codex`。
- `npm run typecheck`：通过（0 错误）。
- `npm run lint`：`eslint .` 仍有 21 个**既有/外部**错误（`.work/otter-installer/source` 副本、`packages/host-runtime/src/external-thread-queue.ts`、既有 browser 测试、会话期间其它进程创建的 `tests/dsh/`）；本次改动涉及的每个文件单独 `npx eslint` 通过，`node tools/check-boundaries.mjs` 通过。
- `npx vitest run --config tests/vitest.config.js packages/host-runtime/test packages/shared-contracts/test packages/harness-plugin-files/test packages/desktop-control`：1279 个测试通过、7 个跳过。
- `cd packages/web-server && node --import tsx --test test/*.test.ts`：184 个测试通过。
- `cd packages/web-server && node --import tsx --test test/distribution/*.test.ts`：6 个测试通过。
- `env -u CODEX_HOME npx vitest run --config tests/vitest.config.js tests/release/host-bundle.test.mjs`：10 个测试通过（该用例的假原生进程使用自身环境，继承调用方 `CODEX_HOME` 时会使用真实 home；CI 不设置该变量）。
- `env -u CODEX_HOME npx vitest run --config tests/vitest.config.js`：6830 个测试通过、47 个跳过、21 个失败。失败中 20 个为 `renderer-extension` 的既有失败（在干净的仓库 HEAD `d2e2c233` 上同样失败，与本次改动无关）；1 个为 `packages/adapters/cursor-cli/test/delegation-bridge.test.ts` 的超时用例，单独复跑 6/6 通过。其余文件全部通过。
- `npx openspec validate web-codex-as-external-harness --strict`：valid。
- `git diff --check`：无输出。

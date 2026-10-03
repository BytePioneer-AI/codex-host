import type { ExternalRendererAgent } from "../agent-selection-state.js";
import type { RendererSettingsLocale } from "./localization.js";

type Text = readonly [en: string, zh: string];
interface InstallationGuide {
  readonly url: string;
  readonly commands: readonly { readonly terminal: string; readonly command: string }[];
  readonly before?: Text;
  readonly after: Text;
  readonly downloads?: readonly { readonly label: string; readonly url: string }[];
}

const shells = (posix: string, windows: string): InstallationGuide["commands"] => [
  { terminal: "macOS / Linux · Terminal (sh/bash)", command: posix },
  { terminal: "Windows · PowerShell", command: windows },
];
const npm = (name: string): InstallationGuide["commands"] => [
  {
    terminal: "macOS / Linux / Windows · Terminal / PowerShell",
    command: `npm install -g ${name}`,
  },
];
const start = (command: string): Text => [
  `After installation, run ${command} to complete login or setup.`,
  `安装后运行 ${command}，完成登录或配置。`,
];
const node: Text = ["Requires Node.js (including npm).", "需先安装 Node.js（包含 npm）。"];

// Sources: each entry's official URL, checked when updating the guide. These are
// user-run instructions, not a Host installer or a claim of Adapter compatibility.
const guides: Readonly<Record<ExternalRendererAgent, InstallationGuide>> = {
  zcode: {
    // codexhost runs the Agent CLI bundled with the installed ZCode Desktop.
    url: "https://github.com/BytePioneer-AI/codex-host/blob/main/docs/harnesses/zcode/zcode-harness-integration.md#%E5%AE%89%E8%A3%85",
    commands: [],
    before: [
      "Install ZCode Desktop and sign in with a Start Plan account. If ZCode is not in the default location (/Applications/ZCode.app on macOS, %LOCALAPPDATA%\\Programs\\ZCode on Windows, /opt/ZCode on Linux), set its path in the connection settings.",
      "请安装 ZCode Desktop 并登录 Start Plan 账号。ZCode 不在默认安装位置（macOS 为 /Applications/ZCode.app，Windows 为 %LOCALAPPDATA%\\Programs\\ZCode，Linux 为 /opt/ZCode）时，可在连接设置中填写其路径。",
    ],
    downloads: [{ label: "ZCode", url: "https://zcode.z.ai/" }],
    after: [
      "Check again after signing in. The ZCode Desktop window does not need to stay open.",
      "登录后重新检测；使用时不需要保持 ZCode 窗口打开。",
    ],
  },
  pi: {
    url: "https://pi.dev/",
    commands: shells(
      "curl -fsSL https://pi.dev/install.sh | sh",
      "irm https://pi.dev/install.ps1 | iex",
    ),
    after: start("pi"),
  },
  "claude-code": {
    url: "https://code.claude.com/docs/en/quickstart",
    commands: shells(
      "curl -fsSL https://claude.ai/install.sh | bash",
      "irm https://claude.ai/install.ps1 | iex",
    ),
    after: start("claude"),
  },
  "deepseek-harness": {
    url: "https://github.com/deepseek-ai/deepseek-harness#run",
    commands: npm("@deepseek-ai/dsh@latest"),
    before: [
      "Requires Node.js. Installs npm's latest version; connection still requires native protocol validation.",
      "需先安装 Node.js。安装 npm 最新版本；连接仍需通过原生协议校验。",
    ],
    after: [
      "Check again, then open Web UI to configure your provider. Stop any manually started dsh web first.",
      "重新检测后，打开 Web UI 配置 Provider。若已手动启动 dsh web，请先停止。",
    ],
  },
  opencode: {
    url: "https://opencode.ai/docs/#install",
    commands: npm("opencode-ai"),
    before: node,
    after: start("opencode"),
  },
  grok: {
    url: "https://www.npmjs.com/package/@xai-official/grok",
    commands: npm("@xai-official/grok"),
    before: [
      "Requires Node.js 20 or later (including npm).",
      "需要 Node.js 20 或更高版本（包含 npm）。",
    ],
    after: start("grok"),
  },
  omp: {
    url: "https://github.com/can1357/oh-my-pi#install",
    commands: shells(
      "curl -fsSL https://omp.sh/install | sh",
      "irm https://omp.sh/install.ps1 | iex",
    ),
    after: start("omp"),
  },
  antigravity: {
    url: "https://antigravity.google/download#antigravity-cli",
    commands: shells(
      "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      "irm https://antigravity.google/cli/install.ps1 | iex",
    ),
    after: start("agy"),
  },
  "kiro-cli": {
    url: "https://kiro.dev/docs/cli/",
    commands: shells(
      "curl -fsSL https://cli.kiro.dev/install | bash",
      "irm 'https://cli.kiro.dev/install.ps1' | iex",
    ),
    after: start("kiro-cli"),
  },
  codebuddy: {
    url: "https://www.codebuddy.ai/docs/zh/cli/overview",
    commands: npm("@tencent-ai/codebuddy-code"),
    before: [
      "Requires Node.js 18 or later (including npm).",
      "需要 Node.js 18 或更高版本（包含 npm）。",
    ],
    after: start("codebuddy"),
  },
  workbuddy: {
    url: "https://www.workbuddy.ai/docs/workbuddy/Quickstart",
    commands: [],
    before: [
      "Download and install the WorkBuddy desktop app.",
      "请下载并安装 WorkBuddy 桌面应用。",
    ],
    downloads: [
      {
        label: "WorkBuddy",
        url: "https://www.workbuddy.ai/",
      },
    ],
    after: [
      "The bundled CLI may require separate login. Restart codexhost after changing the installation path.",
      "内置 CLI 可能需要单独登录。修改安装路径后需重启 codexhost。",
    ],
  },
  "cursor-cli": {
    url: "https://cursor.com/docs/cli/installation",
    commands: shells(
      "curl https://cursor.com/install -fsS | bash",
      "irm 'https://cursor.com/install?win32=true' | iex",
    ),
    after: start("agent"),
  },
  devin: {
    url: "https://docs.devin.ai/cli",
    commands: shells(
      "curl -fsSL https://cli.devin.ai/install.sh | bash",
      "irm https://cli.devin.ai/install.ps1 | iex",
    ),
    after: start("devin auth login"),
  },
  hermes: {
    url: "https://hermes-agent.nousresearch.com/docs/getting-started/installation",
    commands: shells(
      "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
      "iex (irm https://hermes-agent.nousresearch.com/install.ps1)",
    ),
    before: [
      "On macOS/Linux, install Git first. Linux also needs curl and xz-utils.",
      "macOS / Linux 请先安装 Git；Linux 还需要 curl 和 xz-utils。",
    ],
    after: start("hermes"),
  },
  qoder: {
    url: "https://docs.qoder.com/cli/installation",
    commands: shells(
      "curl -fsSL https://qoder.com/install | bash",
      "irm https://qoder.com/install.ps1 | iex",
    ),
    after: start("qodercli"),
  },
  "qoder-cn": {
    url: "https://docs.qoder.cn/cli/installation",
    commands: shells(
      "curl -fsSL https://static.qoder.com.cn/qoder-cli-cn/install.sh | bash",
      "irm https://static.qoder.com.cn/qoder-cli-cn/install.ps1 | iex",
    ),
    after: start("qoderclicn"),
  },
  "kimi-code": {
    url: "https://moonshotai.github.io/kimi-code/en/guides/getting-started.html",
    commands: shells(
      "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
      "irm https://code.kimi.com/kimi-code/install.ps1 | iex",
    ),
    before: ["On Windows, install Git for Windows first.", "Windows 请先安装 Git for Windows。"],
    after: start("kimi"),
  },
};

/** Desktop-app Harnesses have no install command: the user downloads the app instead. */
export function harnessHasInstallCommands(agent: ExternalRendererAgent): boolean {
  return guides[agent].commands.length > 0;
}

export function harnessInstallationGuide(
  agent: ExternalRendererAgent,
  locale: RendererSettingsLocale,
) {
  const guide = guides[agent];
  const index = locale === "zh-CN" ? 1 : 0;
  return { ...guide, before: guide.before?.[index], after: guide.after[index] };
}

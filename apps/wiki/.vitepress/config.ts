import { defineConfig, type DefaultTheme } from "vitepress";
import { generateLlms } from "./llms";

function sidebar(en: boolean): DefaultTheme.SidebarItem[] {
  const base = en ? "/en/docs" : "/docs";
  const item = (path: string, zh: string, english: string) => ({
    text: en ? english : zh,
    link: `${base}${path}`,
  });

  return [
    {
      text: en ? "Getting Started" : "开始",
      items: [
        item("/", "概览", "Overview"),
        item("/quick-start/install", "安装与运行", "Installation"),
        item("/quick-start/accounts-usage", "账号与用量", "Accounts & Usage"),
        item("/quick-start/troubleshooting", "故障排查", "Troubleshooting"),
      ],
    },
    {
      text: en ? "Agents" : "Agent 与协作",
      items: [
        item("/agents/matrix", "能力矩阵", "Capability Matrix"),
        item("/agents/delegation", "多 Agent 委派", "Delegation"),
        item("/agents/schedules", "定时任务", "Schedules"),
      ],
    },
    {
      text: en ? "Web & Mobile" : "Web 与移动端",
      items: [
        item("/web/mobile", "Web 与手机访问", "Web & Mobile"),
        item("/web/relay", "自建 Relay", "Self-Hosted Relay"),
      ],
    },
    {
      text: en ? "Remote Hosts" : "远程开发",
      items: [
        item("/remote/cross-machine", "模式对比", "Overview"),
        item("/remote/ssh", "SSH 远程主机", "SSH Host"),
        item("/remote/remote-control", "Windows 远程控制", "Remote Control"),
      ],
    },
    {
      text: "CLI & API",
      items: [
        item("/platform/interfaces", "接入概览", "Overview"),
        item("/platform/cli", "CLI 参考", "CLI Reference"),
        item("/platform/mcp", "MCP 服务", "MCP Server"),
        item("/platform/http-events", "HTTP API", "HTTP API"),
      ],
    },
  ];
}

export default defineConfig({
  title: "CodexHost",
  description: "在 Codex Desktop 与 Web 中运行本机编码 Agent。",
  cleanUrls: true,
  srcExclude: ["README.md"],
  head: [["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }]],
  locales: {
    root: {
      label: "简体中文",
      lang: "zh-CN",
      themeConfig: {
        nav: [
          { text: "指南", link: "/docs/", activeMatch: "^/docs/(?!agents/matrix|platform/)" },
          { text: "能力矩阵", link: "/docs/agents/matrix" },
          {
            text: "CLI 与 API",
            link: "/docs/platform/interfaces",
            activeMatch: "^/docs/platform/",
          },
        ],
        sidebar: { "/docs/": sidebar(false) },
        outline: { label: "本页目录", level: [2, 3] },
        docFooter: { prev: "上一页", next: "下一页" },
        darkModeSwitchLabel: "外观",
        lightModeSwitchTitle: "切换到浅色模式",
        darkModeSwitchTitle: "切换到深色模式",
        sidebarMenuLabel: "菜单",
        returnToTopLabel: "返回顶部",
        langMenuLabel: "切换语言",
        skipToContentLabel: "跳转到正文",
        notFound: {
          title: "页面未找到",
          quote: "请检查链接，或从导航栏查找所需文档。",
          linkLabel: "返回首页",
          linkText: "返回首页",
        },
        footer: { message: 'CodexHost 文档 · <a href="/llms.txt">llms.txt</a>' },
      },
    },
    en: {
      label: "English",
      lang: "en",
      description: "Run local coding agents inside Codex Desktop and the Web UI.",
      themeConfig: {
        nav: [
          {
            text: "Guide",
            link: "/en/docs/",
            activeMatch: "^/en/docs/(?!agents/matrix|platform/)",
          },
          { text: "Capability Matrix", link: "/en/docs/agents/matrix" },
          {
            text: "CLI & API",
            link: "/en/docs/platform/interfaces",
            activeMatch: "^/en/docs/platform/",
          },
        ],
        sidebar: { "/en/docs/": sidebar(true) },
        outline: { label: "On this page", level: [2, 3] },
        footer: { message: 'CodexHost Documentation · <a href="/llms.txt">llms.txt</a>' },
      },
    },
  },
  themeConfig: {
    logo: { src: "/logo.svg", alt: "CodexHost" },
    socialLinks: [{ icon: "github", link: "https://github.com/BytePioneer-AI/codex-host" }],
    search: {
      provider: "local",
      options: {
        miniSearch: {
          options: {
            tokenize: (text) =>
              Array.from(
                new Intl.Segmenter("zh", { granularity: "word" }).segment(text),
                ({ segment, isWordLike }) => (isWordLike ? segment : ""),
              ).filter(Boolean),
          },
        },
        locales: {
          root: {
            translations: {
              button: { buttonText: "搜索文档", buttonAriaLabel: "搜索文档" },
              modal: {
                displayDetails: "显示详细内容",
                resetButtonTitle: "清除搜索",
                backButtonTitle: "返回搜索",
                noResultsText: "无法找到相关结果",
                footer: {
                  selectText: "选择",
                  selectKeyAriaLabel: "回车键",
                  navigateText: "切换",
                  navigateUpKeyAriaLabel: "上方向键",
                  navigateDownKeyAriaLabel: "下方向键",
                  closeText: "关闭",
                  closeKeyAriaLabel: "退出键",
                },
              },
            },
          },
        },
      },
    },
  },
  buildEnd: generateLlms,
});

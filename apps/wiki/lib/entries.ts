import { Braces, Globe2, Layers3, Network, Rocket, UsersRound } from "lucide-react";

export const entries = [
  {
    slug: "quick-start/install",
    icon: Rocket,
    title: { zh: "5 分钟上手", en: "Up and running in 5 minutes" },
    description: { zh: "从安装开始。", en: "Start with installation." },
  },
  {
    slug: "agents/matrix",
    icon: Layers3,
    title: { zh: "Agent 能力矩阵", en: "Agent capability matrix" },
    description: { zh: "查看各 Agent 的能力。", en: "Explore each Agent’s capabilities." },
  },
  {
    slug: "agents/delegation",
    icon: UsersRound,
    title: { zh: "# 多 Agent 派活", en: "# Multi-Agent delegation" },
    description: { zh: "找到多 Agent 协作入口。", en: "Find your multi-Agent workflow." },
  },
  {
    slug: "platform/interfaces",
    icon: Braces,
    title: { zh: "CLI / MCP / HTTP 底座", en: "CLI / MCP / HTTP foundation" },
    description: { zh: "了解程序化接入方式。", en: "Explore programmatic interfaces." },
  },
  {
    slug: "web/mobile",
    icon: Globe2,
    title: { zh: "Web 端与手机访问", en: "Web and mobile access" },
    description: { zh: "在浏览器中继续工作。", en: "Continue in your browser." },
  },
  {
    slug: "remote/cross-machine",
    icon: Network,
    title: { zh: "跨机远程运行", en: "Run across machines" },
    description: { zh: "查看远程运行入口。", en: "Find remote execution guides." },
  },
] as const;

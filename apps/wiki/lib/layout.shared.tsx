import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import type { Locale } from "@/lib/i18n";

export function baseOptions(lang: Locale): BaseLayoutProps {
  return {
    githubUrl: "https://github.com/BytePioneer-AI/codex-host",
    nav: {
      url: `/${lang}`,
      title: (
        <span className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="" width={24} height={24} className="brand-logo" />
          <span>CodexHost</span>
        </span>
      ),
    },
    links: [
      {
        text: lang === "zh" ? "文档" : "Docs",
        url: `/${lang}/docs`,
        active: "nested-url",
      },
    ],
    themeSwitch: { enabled: true, mode: "light-dark-system" },
  };
}

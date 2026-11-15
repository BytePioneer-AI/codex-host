import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { entries } from "@/lib/entries";
import { isLocale } from "@/lib/i18n";
import { baseOptions } from "@/lib/layout.shared";
import hero from "@/public/images/hero-desktop-phone.png";

export default async function HomePage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const zh = lang === "zh";

  return (
    <HomeLayout {...baseOptions(lang)}>
      <main id="main-content" className="home-main">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <h1 id="hero-title">
              CodexHost<span className="hero-dot">.</span>
            </h1>
            <p className="hero-tagline">
              {zh
                ? "在 Codex 界面里统一使用 15+ 个 Agent，并通过 Web、远程主机与 CLI / MCP / HTTP 随处调度。"
                : "Use 15+ Agents inside the Codex interface, and orchestrate them anywhere via Web, remote hosts, and CLI / MCP / HTTP."}
            </p>
            <div className="hero-actions">
              <Link className="action-primary" href={`/${lang}/docs/quick-start/install`}>
                {zh ? "快速开始" : "Quick Start"}
                <ArrowRight size={16} aria-hidden="true" />
              </Link>
              <Link className="action-secondary" href={`/${lang}/docs/agents/matrix`}>
                {zh ? "Agent 能力矩阵" : "Capability Matrix"}
                <ArrowUpRight size={16} aria-hidden="true" />
              </Link>
            </div>
          </div>
          <div className="hero-visual">
            <Image
              src={hero}
              alt={zh ? "CodexHost 桌面端与手机端同屏预览" : "CodexHost desktop and mobile preview"}
              priority
              placeholder="blur"
              className="hero-image"
              sizes="(max-width: 800px) 100vw, 56vw"
            />
          </div>
        </section>

        <section className="capabilities" aria-label={zh ? "核心功能" : "Core Features"}>
          <div className="capability-grid">
            {entries.map(({ slug, icon: Icon, title, description }) => (
              <Link key={slug} className="capability-card" href={`/${lang}/docs/${slug}`}>
                <span className="card-icon">
                  <Icon size={20} aria-hidden="true" />
                </span>
                <h3>{title[lang]}</h3>
                <p>{description[lang]}</p>
              </Link>
            ))}
          </div>
        </section>

        <footer className="home-footer">
          <span>
            CodexHost <span className="footer-divider">/</span> {zh ? "文档" : "Documentation"}
          </span>
          <div className="footer-links">
            <a href="https://github.com/BytePioneer-AI/codex-host" target="_blank" rel="noreferrer">
              GitHub <ArrowUpRight size={12} aria-hidden="true" />
            </a>
            <Link href="/llms.txt">
              llms.txt <ArrowUpRight size={12} aria-hidden="true" />
            </Link>
          </div>
        </footer>
      </main>
    </HomeLayout>
  );
}

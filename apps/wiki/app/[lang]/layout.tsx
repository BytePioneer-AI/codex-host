import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { RootProvider } from "fumadocs-ui/provider/next";
import { i18nProvider } from "fumadocs-ui/i18n";
import { i18n, isLocale } from "@/lib/i18n";
import { translations } from "@/lib/translations";
import "@/app/globals.css";

export const metadata: Metadata = {
  title: { default: "CodexHost", template: "%s | CodexHost" },
  description: "CodexHost documentation · CodexHost 文档",
  icons: { icon: "/favicon.svg" },
};

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();

  return (
    <html lang={lang} suppressHydrationWarning>
      <body>
        <RootProvider i18n={i18nProvider(translations, lang)}>{children}</RootProvider>
      </body>
    </html>
  );
}

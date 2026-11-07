import type { ReactNode } from "react";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import css from "./ConnectDevicesSection.module.css";

export function SelfHostedRelayHelp({ t }: { t: PropsLocale<"codexhostImport">["t"] }): ReactNode {
  return (
    <details className={css.other} data-self-relay-help>
      <summary>{t("connectDevices.selfRelay.helpTitle")}</summary>
      <div className={css.connectionHelp}>
        <ol className={css.relayTutorial}>
          <li>{t("connectDevices.selfRelay.domain")}</li>
          <li>{t("connectDevices.selfRelay.dns")}</li>
          <li>{t("connectDevices.selfRelay.ports")}</li>
          <li>
            {t("connectDevices.selfRelay.docker")}
            <code>git clone https://github.com/BytePioneer-AI/codex-host.git /opt/codexhost</code>
            <code>cd /opt/codexhost/packages/remote-relay/deploy</code>
            <code>{t("connectDevices.selfRelay.replaceDomain")}</code>
            <code>echo "RELAY_DOMAIN=example.com" &gt; .env</code>
            <code>docker compose up -d --build</code>
          </li>
          <li>{t("connectDevices.selfRelay.connect")}</li>
        </ol>
        <p className={css.meta}>{t("connectDevices.selfRelay.noDomain")}</p>
        <a
          className={css.link}
          href="https://github.com/BytePioneer-AI/codex-host/blob/main/docs/product/self-hosted-relay.md"
          target="_blank"
          rel="noreferrer"
        >
          {t("connectDevices.selfRelay.docs")}
        </a>
      </div>
    </details>
  );
}

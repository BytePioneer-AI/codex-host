/** Web settings page for creating and deleting access tokens, usable only on this computer. */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import {
  webLocalAccessRequiredDetailsSchema,
  type WebAccessTokenCreateResult,
  type WebAccessTokenListResult,
} from "@codexhost/shared-contracts";
import { accessTokenApi, ApiError } from "./api.ts";
import css from "./AccessTokensSection.module.css";

type Translate = PropsLocale<"codexhostImport">["t"];

type View =
  | { kind: "loading" }
  | { kind: "ready"; data: WebAccessTokenListResult }
  | { kind: "non-local"; url: string }
  | { kind: "disabled" }
  | { kind: "failed"; message: string };

function viewOfError(error: unknown): View {
  if (error instanceof ApiError && error.code === "auth/disabled") return { kind: "disabled" };
  if (error instanceof ApiError && error.code === "auth/local-access-required") {
    const details = webLocalAccessRequiredDetailsSchema.safeParse(error.details);
    return { kind: "non-local", url: details.success ? details.data.url : "http://127.0.0.1" };
  }
  return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
}

function CopyField({ label, value, t }: { label: string; value: string; t: Translate }): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <label className={css.field}>
      <span className={css.fieldLabel}>{label}</span>
      <span className={css.fieldRow}>
        <input
          className={css.value}
          readOnly
          value={value}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button
          type="button"
          className={css.button}
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => setCopied(true));
          }}
        >
          {copied ? t("accessTokens.copied") : t("accessTokens.copy")}
        </button>
      </span>
    </label>
  );
}

function Reveal({
  created,
  onDone,
  t,
}: {
  created: WebAccessTokenCreateResult;
  onDone: () => void;
  t: Translate;
}): ReactNode {
  return (
    <section className={css.reveal} data-access-token-reveal>
      <h3 className={css.heading}>{t("accessTokens.revealTitle", { name: created.token.name })}</h3>
      <p className={css.warning} role="alert">
        {t("accessTokens.revealWarning")}
      </p>
      <CopyField label={t("accessTokens.value")} value={created.secret} t={t} />
      {created.links.map((link) => (
        <CopyField
          key={link.url}
          label={t(
            link.kind === "tailscale" ? "accessTokens.linkTailscale" : "accessTokens.linkLan",
          )}
          value={link.url}
          t={t}
        />
      ))}
      {created.links.length > 0 && <p className={css.hint}>{t("accessTokens.linksPrivate")}</p>}
      <div>
        <button type="button" className={css.button} onClick={onDone}>
          {t("accessTokens.done")}
        </button>
      </div>
    </section>
  );
}

/**
 * @param props - slot props with the locale seat.
 * @returns the page for this access: the token list locally, guidance otherwise.
 */
export function AccessTokensSection({ t }: PropsLocale<"codexhostImport">): ReactNode {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<WebAccessTokenCreateResult | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setView({ kind: "ready", data: await accessTokenApi.list() });
    } catch (cause) {
      setView(viewOfError(cause));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const describe = (cause: unknown): string => {
    if (cause instanceof ApiError && cause.code === "auth/invalid-token-name")
      return t("accessTokens.invalidName");
    if (cause instanceof ApiError && cause.code === "auth/duplicate-token-name")
      return t("accessTokens.duplicateName");
    return t("accessTokens.actionFailed", {
      message: cause instanceof Error ? cause.message : String(cause),
    });
  };
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    void run(async () => {
      setCreated(await accessTokenApi.create(name));
      setName("");
    });
  };

  if (view.kind === "loading") return <p className={css.hint}>{t("accessTokens.loading")}</p>;
  if (view.kind === "non-local")
    return (
      <p className={css.notice} data-access-token-notice="non-local">
        {t("accessTokens.localOnly", { url: view.url })}
      </p>
    );
  if (view.kind === "disabled")
    return (
      <p className={css.notice} data-access-token-notice="disabled">
        {t("accessTokens.disabled")}
      </p>
    );
  if (view.kind === "failed")
    return (
      <p className={css.error} role="alert">
        {t("accessTokens.loadFailed", { message: view.message })}
      </p>
    );

  const { tokens, networkUrls } = view.data;
  const time = (value: number): string => new Date(value).toLocaleString();
  return (
    <div className={css.page}>
      <p className={css.hint}>{t("accessTokens.description")}</p>
      <form className={css.create} onSubmit={submit}>
        <input
          className={css.value}
          value={name}
          maxLength={64}
          aria-label={t("accessTokens.nameLabel")}
          placeholder={t("accessTokens.namePlaceholder")}
          onChange={(event) => setName(event.currentTarget.value)}
        />
        <button type="submit" className={css.button} disabled={busy}>
          {t("accessTokens.create")}
        </button>
      </form>
      {error !== null && (
        <p className={css.error} role="alert">
          {error}
        </p>
      )}
      {created !== null && (
        <Reveal key={created.token.id} created={created} onDone={() => setCreated(null)} t={t} />
      )}
      {tokens.length === 0 ? (
        <p className={css.hint}>{t("accessTokens.listEmpty")}</p>
      ) : (
        <ul className={css.list}>
          {tokens.map((token) => (
            <li key={token.id} className={css.row} data-access-token-row={token.name}>
              <div className={css.rowText}>
                <div className={css.name}>{token.name}</div>
                <div className={css.meta}>
                  {t("accessTokens.created", { time: time(token.createdAt) })}
                  {" · "}
                  {token.lastUsedAt === null
                    ? t("accessTokens.neverUsed")
                    : t("accessTokens.lastUsed", { time: time(token.lastUsedAt) })}
                </div>
                {token.secret === null && (
                  <p className={css.hint}>{t("accessTokens.secretUnavailable")}</p>
                )}
                {confirming === token.id && (
                  <div className={css.warning}>
                    {t("accessTokens.confirmDelete", { name: token.name })}
                  </div>
                )}
              </div>
              <div className={css.actions}>
                {token.secret !== null && (
                  <button
                    type="button"
                    className={css.button}
                    onClick={() => {
                      if (token.secret === null) return;
                      setCreated({
                        token,
                        secret: token.secret,
                        links: networkUrls.map((entry) => ({
                          kind: entry.kind,
                          url: `${entry.url}#token=${token.secret}`,
                        })),
                      });
                    }}
                  >
                    {t("accessTokens.view")}
                  </button>
                )}
                {confirming === token.id && (
                  <button type="button" className={css.button} onClick={() => setConfirming(null)}>
                    {t("accessTokens.cancel")}
                  </button>
                )}
                <button
                  type="button"
                  className={css.button}
                  disabled={busy}
                  data-danger={confirming === token.id ? true : undefined}
                  onClick={() => {
                    if (confirming !== token.id) {
                      setConfirming(token.id);
                      return;
                    }
                    setConfirming(null);
                    void run(async () => {
                      await accessTokenApi.delete(token.id);
                      if (created?.token.id === token.id) setCreated(null);
                    });
                  }}
                >
                  {t("accessTokens.delete")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <section className={css.network}>
        <h3 className={css.heading}>{t("accessTokens.networkTitle")}</h3>
        {networkUrls.length === 0 ? (
          <p className={css.hint}>{t("accessTokens.localListener")}</p>
        ) : (
          <>
            <ul className={css.addresses}>
              {networkUrls.map((entry) => (
                <li key={entry.url}>{entry.url}</li>
              ))}
            </ul>
            <p className={css.warning}>{t("accessTokens.plaintext")}</p>
          </>
        )}
      </section>
    </div>
  );
}

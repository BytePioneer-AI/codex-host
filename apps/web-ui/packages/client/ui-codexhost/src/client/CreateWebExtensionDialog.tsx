/** Guided modal for creating and publishing a codexhost Web native extension. */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  Button,
  IconCheckOutlineRegular,
  IconCopyOutlineRegular,
  IconRightUpOutlineRegular,
  Modal,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { copyText } from "./api.ts";
import type { Translate } from "./web-extensions-helpers.ts";
import css from "./CreateWebExtensionDialog.module.css";

const EXTENSION_DOCS_URL =
  "https://github.com/BytePioneer-AI/codex-host/blob/main/docs/proposals/web-native-extensions.md";
const MARKETPLACE_SUBMIT_URL =
  "https://github.com/BytePioneer-AI/codexhost-extensions-registry/issues/new/choose";

interface Props {
  open: boolean;
  onClose: () => void;
  t: Translate;
}

export function CreateWebExtensionDialog({ open, onClose, t }: Props): ReactNode {
  const defaultPrompt = t("extensions.create.promptTemplate");
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const promptId = useId();
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setPrompt(defaultPrompt);
  }, [defaultPrompt]);

  useEffect(() => {
    if (!open) {
      setCopyState("idle");
      if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    }
    return () => {
      if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    };
  }, [open]);

  const handleCopy = () => {
    void copyText(prompt).then(
      () => {
        setCopyState("copied");
        if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
        resetTimerRef.current = setTimeout(() => setCopyState("idle"), 2_000);
      },
      () => {
        setCopyState("failed");
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("extensions.create.title")}
      closeLabel={t("extensions.close")}
      className={css.dialog}
      contentClassName={css.content}
      footer={
        <div className={css.footer}>
          <div className={css.links}>
            <a
              className={css.link}
              href={EXTENSION_DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span>{t("extensions.create.docs")}</span>
              <IconRightUpOutlineRegular size={12} />
            </a>
            <a
              className={css.link}
              href={MARKETPLACE_SUBMIT_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span>{t("extensions.create.submit")}</span>
              <IconRightUpOutlineRegular size={12} />
            </a>
          </div>
          <Button
            variant="primary"
            icon={
              copyState === "copied" ? (
                <IconCheckOutlineRegular size={14} />
              ) : (
                <IconCopyOutlineRegular size={14} />
              )
            }
            onClick={handleCopy}
          >
            {t(copyState === "copied" ? "extensions.create.copied" : "extensions.create.copy")}
          </Button>
        </div>
      }
    >
      <div className={css.body}>
        <ol className={css.steps}>
          <li>{t("extensions.create.step1")}</li>
          <li>{t("extensions.create.step2")}</li>
          <li>{t("extensions.create.step3")}</li>
        </ol>

        <div className={css.field}>
          <label htmlFor={promptId} className={css.label}>
            {t("extensions.create.promptLabel")}
          </label>
          <textarea
            id={promptId}
            className={css.textarea}
            rows={10}
            spellCheck={false}
            value={prompt}
            onChange={(event) => setPrompt(event.currentTarget.value)}
          />
          {copyState === "copied" && (
            <p className={css.status} data-tone="success" role="status">
              {t("extensions.create.copiedHint")}
            </p>
          )}
          {copyState === "failed" && (
            <p className={css.status} data-tone="danger" role="alert">
              {t("extensions.create.copyFailed")}
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}

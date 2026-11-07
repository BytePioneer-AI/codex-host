import { useState, type ReactNode } from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { WebToolOutputPreview, WebToolOutputReference } from "@codexhost/shared-contracts";
import type { ToolResultNode, UseDisclosure } from "@deepseek-ai/dsh-client-ui-chat/client";
import type { TranslateNS } from "@deepseek-ai/dsh-client-ui-slots";

/** Resolve preview text while retaining the normal tool view and its single copy control. */
export function LazyToolOutput({
  block,
  previews,
  read,
  useDisclosure,
  t,
  children,
}: {
  block: ToolResultNode;
  previews: readonly WebToolOutputPreview[];
  read: (reference: WebToolOutputReference) => Promise<string>;
  useDisclosure: UseDisclosure;
  t: TranslateNS<"conversation">;
  children: (
    block: ToolResultNode,
    copyOutput: () => Promise<string>,
    useDisclosure: UseDisclosure,
  ) => ReactNode;
}) {
  const disclosure = useDisclosure();
  const [full, setFull] = useState<ToolResultNode>();
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const size = Math.ceil(previews.reduce((total, preview) => total + preview.bytes, 0) / 1024);

  async function load(): Promise<ToolResultNode> {
    if (full) return full;
    setLoading(true);
    setError(undefined);
    try {
      const texts = await Promise.all(previews.map(({ reference }) => read(reference)));
      const replacements = new Map(
        previews.map((preview, i) => [preview.reference.part, texts[i] as string]),
      );
      const value = {
        ...block,
        content: block.content.map((part, i) =>
          part.type === "text" && replacements.has(i)
            ? { ...part, text: replacements.get(i) as string }
            : part,
        ),
      };
      setFull(value);
      return value;
    } catch (failure) {
      setError(
        typeof failure === "object" &&
          failure !== null &&
          "code" in failure &&
          failure.code === "session/tool-output-stale"
          ? t("tool.output.stale")
          : t("tool.output.failed"),
      );
      throw failure;
    } finally {
      setLoading(false);
    }
  }
  async function expand(): Promise<void> {
    try {
      await load();
      disclosure.setExpanded(true);
      setExpanded(true);
    } catch {
      return;
    }
  }
  async function copyOutput(): Promise<string> {
    const value = await load();
    return value.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
  }
  return (
    <div data-tool-output-preview>
      {children(expanded && full ? full : block, copyOutput, () => disclosure)}
      {!expanded && (
        <Button variant="ghost" size="sm" disabled={loading} onClick={() => void expand()}>
          {loading
            ? t("tool.output.loading")
            : error
              ? t("tool.output.retry")
              : t("tool.output.showFull", { size: String(size) })}
        </Button>
      )}
      {loading && <span role="status">{t("tool.output.loading")}</span>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

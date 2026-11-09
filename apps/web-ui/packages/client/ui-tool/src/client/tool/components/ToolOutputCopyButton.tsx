import { Button, useCopyFeedback } from "@deepseek-ai/dsh-client-ui-primitives";
import type { TranslateNS } from "@deepseek-ai/dsh-client-ui-slots";

/** Generic result bodies without a built-in copy control use the same async text reader. */
export function ToolOutputCopyButton({
  read,
  t,
}: {
  read: () => Promise<string>;
  t: TranslateNS<"conversation">;
}) {
  const { copied, onCopy } = useCopyFeedback(read);
  return (
    <Button variant="ghost" size="sm" onClick={onCopy}>
      {copied ? t("copied") : t("copy")}
    </Button>
  );
}

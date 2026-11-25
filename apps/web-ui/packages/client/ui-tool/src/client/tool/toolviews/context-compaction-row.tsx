import type { Context } from "@deepseek-ai/cordis";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";
import { IconApiOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ToolCallViewProps } from "../../contract/slots.ts";
import { CONVERSATION_NS as NS } from "../../locale.ts";
import { ToolRow } from "../components/ToolRow.tsx";
import { toolRowModel } from "../models/tool-call-model.ts";

type ContextCompactionRowProps = ToolCallViewProps & PropsLocale<"conversation">;

/** Render the standard Host compaction Item as a first-class lifecycle row. */
export function ContextCompactionRow({
  toolName,
  block,
  useDisclosure,
  t,
}: ContextCompactionRowProps) {
  const model = toolRowModel(toolName, block);
  const title =
    model.state === "running" || model.state === "preparing"
      ? t("tool.contextCompaction.running")
      : model.state === "ok"
        ? t("tool.contextCompaction.completed")
        : t("tool.contextCompaction.action");
  return (
    <ToolRow
      useDisclosure={useDisclosure}
      t={t}
      variant="others"
      toolName={toolName}
      icon={<IconApiOutlineRegular size={14} />}
      title={title}
      summary=""
      bodyRaw={null}
      output={model.state === "ok" ? null : model.output}
      errorSummary={model.errorSummary}
      state={model.state}
    />
  );
}

/** Register the canonical Web projection used by manual and automatic compaction. */
export const contextCompactionToolview = {
  name: "context-compaction-toolview",
  inject: ["slots"],
  apply(ctx: Context): void {
    ctx.slots.inject("tool.call.toolview", () =>
      ctx.slots.register(
        { name: "tool.call.toolview", key: "compact_context", locale: NS },
        ContextCompactionRow,
      ),
    );
  },
};

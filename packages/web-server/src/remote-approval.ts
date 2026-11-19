type Request = { method: string; params: Record<string, unknown> };
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

/** Present only the action being approved, never transport IDs or opaque params. */
export function remoteApprovalPresentation(request: Request, thread?: { turns?: unknown }) {
  const p = request.params;
  const rows = Array.isArray(thread?.turns) ? thread.turns : [];
  const items = rows.flatMap((turn: { items?: unknown }) =>
    Array.isArray(turn?.items) ? turn.items : [],
  );
  const item: Record<string, unknown> | undefined =
    typeof p.itemId === "string"
      ? items.find((value: Record<string, unknown>) => value?.id === p.itemId)
      : undefined;
  const changes = p.changes ?? item?.changes;

  const command =
    text(p.command) ??
    text(item?.command) ??
    (Array.isArray(p.command) && p.command.every((v) => typeof v === "string")
      ? p.command.map((v) => JSON.stringify(v)).join(" ")
      : undefined);
  const paths = [
    text(p.grantRoot),
    ...(Array.isArray(p.paths) ? p.paths.map(text) : []),
    ...(Array.isArray(changes)
      ? changes.map((change) => text(change?.path))
      : changes && typeof changes === "object"
        ? Object.keys(changes)
        : []),
  ].filter((v): v is string => v !== undefined);
  const isCommand = request.method === "item/commandExecution/requestApproval";
  const reason = text(p.reason),
    cwd = text(p.cwd);
  const render = (zh: boolean) =>
    [
      isCommand
        ? zh
          ? "允许执行以下命令？"
          : "Allow this command?"
        : zh
          ? "允许修改以下文件？"
          : "Allow these file changes?",
      isCommand ? command : [...new Set(paths)].join("\n"),
      cwd ? `${zh ? "工作目录" : "Working directory"}: ${cwd}` : undefined,
      reason ? `${zh ? "原因" : "Reason"}: ${reason}` : undefined,
      !isCommand && paths.length === 0
        ? zh
          ? "请查看当前会话中的待审批文件变更。"
          : "Review the pending file changes in this conversation."
        : undefined,
    ]
      .filter(Boolean)
      .join("\n\n");
  return {
    toolName: isCommand ? "shell" : "files",
    reason: render(false),
    displayReason: { en: render(false), zh: render(true) },
  };
}

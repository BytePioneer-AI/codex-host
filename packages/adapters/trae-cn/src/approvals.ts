import { TraeError } from "./errors.js";

const fileTools = new Set([
  "create_file",
  "edit_file_search_replace",
  "Edit",
  "MultiEdit",
  "SearchReplace",
  "write_to_file",
  "Write",
  "NotebookEdit",
  "Read",
  "view_file",
  "view_files",
  "delete_file",
  "DeleteFile",
]);

export function supportsApprovalTool(name: unknown): boolean {
  return (
    typeof name === "string" &&
    (name === "RunCommand" ||
      name === "run_mcp" ||
      name === "ReadMcpResource" ||
      fileTools.has(name))
  );
}

function approvalResources(confirm: Record<string, unknown>): string[] {
  const fields: Record<string, string> = {
    permission_request_rw_paths: "读写路径",
    permission_request_ro_paths: "只读路径",
    permission_request_networks: "网络目标",
    permission_request_command_prefixes: "命令前缀",
    permission_request_mcp_tools: "MCP 工具",
  };
  return Object.entries(fields).flatMap(([field, label]) => {
    const values = confirm[field];
    if (values === undefined || values === null) return [];
    if (
      !Array.isArray(values) ||
      values.length > 100 ||
      !values.every((value) => typeof value === "string" && value.trim() && value.length <= 4096)
    )
      throw new TraeError("protocolError", "Invalid native approval resources");
    return values.length ? [`${label}:`, ...values] : [];
  });
}

export function approvalDescription(
  tool: Record<string, unknown>,
  params: Record<string, unknown>,
  confirm: Record<string, unknown>,
): { title: string; description: string } | undefined {
  const reason =
    typeof confirm.permission_request_reason === "string" ? confirm.permission_request_reason : "";
  const resources = approvalResources(confirm);
  if (tool.name === "RunCommand") {
    if (typeof params.command !== "string" || !params.command.trim())
      throw new TraeError("protocolError", "Native command approval has no command");
    return {
      title: "TRAE CN 请求执行命令",
      description: [
        params.command,
        typeof params.cwd === "string" ? `cwd: ${params.cwd}` : "",
        ...resources,
        reason,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (tool.name === "run_mcp" || tool.name === "ReadMcpResource") {
    const server = tool.name === "ReadMcpResource" ? params.server : params.server_name;
    const target = tool.name === "ReadMcpResource" ? params.uri : params.tool_name;
    if (
      typeof server !== "string" ||
      !server.trim() ||
      typeof target !== "string" ||
      !target.trim()
    )
      throw new TraeError("protocolError", "Native MCP approval has no server or target");
    const args = params.args === undefined ? "" : JSON.stringify(params.args);
    if (Buffer.byteLength(args, "utf8") > 16384)
      throw new TraeError("unsupported", "Native MCP approval arguments exceed 16 KiB");
    return {
      title: "TRAE CN 请求调用 MCP 工具",
      description: [`${server} / ${target}`, args, ...resources, reason].filter(Boolean).join("\n"),
    };
  }
  if (fileTools.has(String(tool.name))) {
    const paths =
      params.file_paths ??
      [params.file_path ?? params.path ?? params.notebook_path, params.renameFilePath].filter(
        Boolean,
      );
    if (
      !Array.isArray(paths) ||
      !paths.length ||
      paths.length > 100 ||
      !paths.every((path) => typeof path === "string" && path.trim() && path.length <= 4096) ||
      typeof tool.id !== "string" ||
      !tool.id.trim()
    )
      throw new TraeError(
        "protocolError",
        "Native file approval has no valid paths or tool-call identity",
      );
    return {
      title: ["delete_file", "DeleteFile"].includes(String(tool.name))
        ? "TRAE CN 请求删除文件"
        : "TRAE CN 请求访问或修改文件",
      description: [String(tool.name), ...paths, ...resources, reason].filter(Boolean).join("\n"),
    };
  }
  return undefined;
}

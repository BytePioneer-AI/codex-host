/** `approval` namespace dictionaries. */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  waiting: "等待审批",
  "detail.aria": "审批详情",
  escalation: "允许运行工具 {toolName}？",
  reject: "拒绝",
  allowOnce: "允许一次",
  expand: "展开",
  collapse: "收起",
  moreOptions: "更多允许选项",
  categoryTerminal: "终端",
  categoryFiles: "编辑文件",
  categoryPermission: "权限请求",
} satisfies Record<string, string>;

/** Approval dictionary key union. */
export type ApprovalKey = keyof typeof zh;

/** English dictionary, checked against the Chinese key set. */
export const en = {
  waiting: "Waiting for approval",
  "detail.aria": "Approval details",
  escalation: "Allow running {toolName}?",
  reject: "Deny",
  allowOnce: "Allow once",
  expand: "Expand",
  collapse: "Collapse",
  moreOptions: "Approval options",
  categoryTerminal: "Terminal",
  categoryFiles: "Edit files",
  categoryPermission: "Ask permission",
} satisfies Record<ApprovalKey, string>;

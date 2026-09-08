/** MSP methods this adapter actually sends. Keep in sync with session/adapter call sites. */
export const MUSE_MSP_REQUEST_METHODS = [
  "initialize",
  "model/list",
  "session/start",
  "session/resume",
  "session/fork",
  "session/read",
  "session/setModel",
  "session/setApprovalMode",
  "turn/start",
  "turn/cancel",
  "approval/decide",
  "userInput/answer",
  "userInput/cancel",
  "view/page",
] as const;

/** MSP notifications this adapter handles. Unlisted events are ignored, not fatal. */
export const MUSE_MSP_NOTIFICATIONS = [
  "turn/completed",
  "item/started",
  "item/delta",
  "item/updated",
  "item/completed",
  "approval/requested",
  "approval/updated",
  "approval/resolved",
  "userInput/requested",
  "userInput/settled",
  "view/gap",
  "session/approvalModeChanged",
] as const;

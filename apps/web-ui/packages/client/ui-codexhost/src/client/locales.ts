/** Copy for the CodexHost import panel. */
export const en = {
  panel: "Import sessions",
  title: "Import sessions",
  subtitle:
    "Continue a session you started in a Harness on this computer. Its history is loaded when you open it.",
  search: "Search by title or folder",
  import: "Import",
  open: "Open",
  importing: "Importing…",
  empty: "No sessions found.",
  loading: "Loading sessions…",
  untitled: "Untitled session",
  error: "Could not load sessions: {message}",
  noSources: "No installed Harness can import sessions.",
  more: "Showing {shown} of {total}",
  "notifications.title": "Notifications",
  "notifications.on":
    "This device is notified when a turn finishes or an agent needs your approval or answer.",
  "notifications.off": "Get notified on this device when a turn finishes or an agent needs you.",
  "notifications.denied": "Notifications are blocked for this site in your browser settings.",
  "notifications.unsupported": "This browser does not support push notifications.",
  "notifications.needs-install":
    "On iPhone and iPad, add CodexHost to the Home Screen (Share → Add to Home Screen), then enable notifications there.",
  "notifications.enable": "Enable",
  "notifications.disable": "Turn off",
  "notifications.test": "Send test",
} as const;

export type ImportLocaleKey = keyof typeof en;

export const zh: Record<ImportLocaleKey, string> = {
  panel: "导入会话",
  title: "导入会话",
  subtitle: "继续你在这台电脑上用 Harness 开过的会话，打开时会加载完整历史。",
  search: "按标题或文件夹搜索",
  import: "导入",
  open: "打开",
  importing: "正在导入…",
  empty: "没有找到会话。",
  loading: "正在加载会话…",
  untitled: "未命名会话",
  error: "无法加载会话：{message}",
  noSources: "没有已安装的 Harness 支持导入会话。",
  more: "显示 {shown} / {total} 个",
  "notifications.title": "通知",
  "notifications.on": "一轮结束、需要审批或回答问题时，会通知这台设备。",
  "notifications.off": "一轮结束或 Agent 需要你时，在这台设备上收到通知。",
  "notifications.denied": "浏览器设置中已阻止此网站的通知。",
  "notifications.unsupported": "此浏览器不支持推送通知。",
  "notifications.needs-install":
    "在 iPhone / iPad 上，请先把 CodexHost 添加到主屏幕（分享 → 添加到主屏幕），再在那里开启通知。",
  "notifications.enable": "开启",
  "notifications.disable": "关闭",
  "notifications.test": "发送测试",
};

const messages = {
  overview: ["Task center", "任务中心"],
  runningCount: ["Running", "运行中"],
  waitingCount: ["Waiting", "待处理"],
  unreadCount: ["Unread", "未读通知"],
  unknownAgent: ["Agent", "Agent"],
  sessions: ["Recent sessions", "最近会话"],
  summary: ["{running} running · {waiting} waiting", "{running} 个运行中 · {waiting} 个待处理"],
  empty: ["All quiet for now", "现在很安静"],
  emptyHint: [
    "Sessions appear here when tasks change on this Host.",
    "此宿主的任务有变化时，会话会显示在这里。",
  ],
  more: [
    "Up to 32 recent sessions, with attention first.",
    "最多显示 32 个近期会话，待处理任务优先。",
  ],
  open: ["Open CodexHost", "打开 CodexHost"],
  openSession: ["Open session", "打开会话"],
  opened: ["Opening the CodexHost window…", "正在打开 CodexHost 窗口…"],
  acknowledge: ["Mark read", "确认通知"],
  read: [
    "Notifications marked read. Pending requests still need your answer.",
    "通知已确认，待处理的请求仍需你来回答。",
  ],
  preferences: ["Window preferences", "浮窗偏好"],
  preferencesHint: ["Make a little room for your companion.", "让陪伴适合你的工作方式。"],
  hoverHint: ["A quick look at your sessions", "移到宠物上即可查看会话"],
  bubbleHint: ["Task updates at a glance", "不展开也能看到任务状态"],
  lockHint: ["Prevent accidental moves", "固定在这里，避免误拖动"],
  back: ["Back to tasks", "返回任务"],
  size: ["Pet size", "宠物大小"],
  hover: ["Expand on hover", "悬停时展开"],
  bubble: ["Show status bubble", "显示状态气泡"],
  lock: ["Lock position", "锁定位置"],
  hide: ["Hide pet", "隐藏宠物"],
  hideHint: ["Show it again from Pet Companion preferences.", "可在宠物伙伴的偏好设置中重新显示。"],
  pin: ["Keep overview open", "固定任务面板"],
  unpin: ["Unpin overview", "取消固定"],
  close: ["Close overview", "收起面板"],
  pet: ["Show tasks; drag to move", "查看任务；按住拖动可移动"],
  lockedPet: ["Show tasks; position locked", "查看任务；位置已锁定"],
  untitled: ["Untitled session", "未命名会话"],
  idle: ["Here with you", "陪你工作"],
  working: ["Working on it", "正在努力"],
  waiting: ["Needs your attention", "需要你来看看"],
  success: ["A task is complete", "任务完成啦"],
  error: ["A task needs a look", "任务遇到问题"],
  stateIdle: ["Idle", "空闲"],
  stateRunning: ["Running", "运行中"],
  stateWaiting: ["Waiting for you", "等你处理"],
  stateCompleted: ["Completed", "已完成"],
  stateFailed: ["Failed", "遇到问题"],
  reconnecting: ["Reconnecting…", "正在重连…"],
  failed: ["Could not complete the action. Try again.", "操作未完成，请重试。"],
  otterName: ["CodexHost Otter", "CodexHost 水獭"],
};

export const translate = (locale, key, values = {}) => {
  let text = messages[key]?.[locale.toLowerCase().startsWith("zh") ? 1 : 0] ?? key;
  for (const [name, value] of Object.entries(values))
    text = text.replaceAll(`{${name}}`, String(value));
  return text;
};

export interface DelegationMessages {
  readonly title: string;
  readonly description: string;
  readonly heroAriaLabel: string;
  readonly eyebrowOrigin: string;
  readonly eyebrowLanes: string;
  readonly eyebrowReturn: string;
  readonly originTitle: string;
  readonly originSubtitle: string;
  readonly returnTitle: string;
  readonly returnSubtitle: string;
  readonly stateWaiting: string;
  readonly stateDispatching: string;
  readonly stateRunning: string;
  readonly stateReturning: string;
  readonly stateReturned: string;
  readonly feedPending: string;
  readonly feedRunning: string;
  readonly actionRead: string;
  readonly actionReadDone: string;
  readonly actionFollowUp: string;
  readonly actionFollowUpDone: string;
  readonly laneTasks: readonly [string, string, string];
  readonly laneDurations: readonly [string, string, string];
  readonly laneDefaultModel: string;
  readonly howtoAriaLabel: string;
  readonly howtoPrefix: string;
  readonly howtoSuffix: string;
  readonly howtoCopyTitle: string;
  readonly howtoCopy: string;
  readonly howtoCopied: string;
  readonly howtoCopyFailed: string;
  readonly howtoAlt: string;
  readonly exampleTasks: readonly [string, string, string];
  readonly modelsTitle: string;
  readonly priorityPrefix: string;
  readonly prioritySteps: readonly [string, string, string];
  readonly followAgentDefault: string;
  readonly defaultThinking: string;
  readonly modelSelectLabel: string;
  readonly thinkingSelectLabel: string;
  readonly effectivePrefix: string;
  readonly reset: string;
  readonly loadingModels: string;
  readonly loadFailed: string;
  readonly saveFailed: string;
  readonly retry: string;
  readonly unavailable: string;
  readonly footnote: string;
}

export const delegationEnglish: DelegationMessages = Object.freeze({
  title: "Multi-Agent Collaboration",
  description:
    "Delegate tasks from your main session to other Agents. Each runs in parallel in its own session, returns results when done, and stays open for follow-ups.",
  heroAriaLabel: "Multi-Agent delegation and return flow",
  eyebrowOrigin: "Dispatch",
  eyebrowLanes: "Independent sessions · Parallel",
  eyebrowReturn: "Return",
  originTitle: "Main session",
  originSubtitle: "# mention or auto-delegate",
  returnTitle: "Back to main",
  returnSubtitle: "Notify · Inspect · Follow up",
  stateWaiting: "Queued",
  stateDispatching: "Dispatching",
  stateRunning: "Running",
  stateReturning: "Returning",
  stateReturned: "Returned",
  feedPending: "Waiting",
  feedRunning: "Running…",
  actionRead: "Read",
  actionReadDone: "Opened",
  actionFollowUp: "Follow up",
  actionFollowUpDone: "Drafted",
  laneTasks: Object.freeze(["Add unit tests", "Review changes", "Check latest docs"] as const),
  laneDurations: Object.freeze(["2m 24s", "3m 06s", "1m 48s"] as const),
  laneDefaultModel: "Default",
  howtoAriaLabel: "Quick start",
  howtoPrefix: "Type",
  howtoSuffix: "to delegate",
  howtoCopyTitle: "Click to copy example and cycle to the next one",
  howtoCopy: "Copy",
  howtoCopied: "Copied",
  howtoCopyFailed: "Copy failed",
  howtoAlt: "Or simply ask your main Agent in plain language to delegate",
  exampleTasks: Object.freeze([
    "review these changes",
    "add edge-case unit tests",
    "check recent changes in this library",
  ] as const),
  modelsTitle: "Default models when delegated",
  priorityPrefix: "Priority:",
  prioritySteps: Object.freeze(["Per-delegation", "Defaults here", "Agent's own default"] as const),
  followAgentDefault: "Follow Agent default",
  defaultThinking: "Default thinking",
  modelSelectLabel: "{agent} default delegation model",
  thinkingSelectLabel: "{agent} thinking level",
  effectivePrefix: "Active:",
  reset: "Reset",
  loadingModels: "Loading models…",
  loadFailed: "Could not load models.",
  saveFailed: "Could not save setting.",
  retry: "Retry",
  unavailable: "Delegation preferences are unavailable on this Host.",
  footnote:
    "Leave unset to follow each Agent's own default configuration. Applies only to newly delegated sessions.",
});

export const delegationChinese: DelegationMessages = Object.freeze({
  title: "多 Agent 协作",
  description: "在主会话把任务交给其他 Agent，各自开独立会话并行处理，完成后回流结果并可继续追问。",
  heroAriaLabel: "多 Agent 委派与回流示意图",
  eyebrowOrigin: "发起",
  eyebrowLanes: "独立会话 · 并行执行",
  eyebrowReturn: "回流",
  originTitle: "主会话",
  originSubtitle: "# 派发或自主委派",
  returnTitle: "回到主会话",
  returnSubtitle: "通知 · 查看 · 追问",
  stateWaiting: "待派发",
  stateDispatching: "派发中",
  stateRunning: "并行处理中",
  stateReturning: "回流中",
  stateReturned: "已回流",
  feedPending: "等待回流",
  feedRunning: "执行中…",
  actionRead: "读结果",
  actionReadDone: "已展开",
  actionFollowUp: "追问",
  actionFollowUpDone: "已带入",
  laneTasks: Object.freeze(["补全单测", "审查变更", "查新文档"] as const),
  laneDurations: Object.freeze(["2m 24s", "3m 06s", "1m 48s"] as const),
  laneDefaultModel: "跟随默认",
  howtoAriaLabel: "快速上手",
  howtoPrefix: "输入",
  howtoSuffix: "唤起委派",
  howtoCopyTitle: "点击复制示例并切换下一条",
  howtoCopy: "复制",
  howtoCopied: "已复制",
  howtoCopyFailed: "复制失败",
  howtoAlt: "也可直接自然语言让主 Agent 自行委派",
  exampleTasks: Object.freeze(["审查这次改动", "补全边界单测", "查这个库的最新变更"] as const),
  modelsTitle: "被委派时的默认模型",
  priorityPrefix: "优先级：",
  prioritySteps: Object.freeze(["本次指定", "这里的默认", "Agent 自己的默认"] as const),
  followAgentDefault: "跟随 Agent 默认",
  defaultThinking: "默认强度",
  modelSelectLabel: "{agent} 被委派默认模型",
  thinkingSelectLabel: "{agent} 思考强度",
  effectivePrefix: "当前生效：",
  reset: "重置",
  loadingModels: "正在加载模型…",
  loadFailed: "无法加载模型列表。",
  saveFailed: "保存失败，请重试。",
  retry: "重试",
  unavailable: "当前 Host 暂不支持委派默认配置。",
  footnote: "不设置则使用各 Agent 自己的默认配置，只对新建的委派会话生效。",
});

import type { ExternalRendererAgent } from "../agent-selection-state.js";

export const HARNESS_OFFICIAL_WEBSITES: Readonly<Record<ExternalRendererAgent, string>> = {
  pi: "https://pi.dev/",
  "claude-code": "https://code.claude.com/",
  "deepseek-harness": "https://github.com/deepseek-ai/deepseek-harness",
  opencode: "https://opencode.ai/",
  grok: "https://www.npmjs.com/package/@xai-official/grok",
  omp: "https://github.com/can1357/oh-my-pi",
  antigravity: "https://antigravity.google/",
  "kiro-cli": "https://kiro.dev/",
  codebuddy: "https://www.codebuddy.ai/",
  workbuddy: "https://www.workbuddy.ai/",
  "cursor-cli": "https://cursor.com/",
  devin: "https://devin.ai/",
  hermes: "https://hermes-agent.nousresearch.com/",
  qoder: "https://qoder.com/",
  "qoder-cn": "https://qoder.cn/",
  "kimi-code": "https://code.kimi.com/",
  zcode: "https://zcode.z.ai/",
};

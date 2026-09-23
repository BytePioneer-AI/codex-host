/**
 * Canonical Renderer Agent catalog.
 *
 * The Desktop Controller installs the Renderer Bundle and then validates the
 * resulting binding by comparing its `enabledAgents` sequence element by
 * element against this exact order. The order is therefore part of the
 * negotiated contract, not a free-form set: it is also the order in which the
 * Renderer presents the Agents.
 *
 * Both the Controller and the Renderer Bundle must derive their catalog from
 * this module. They are bundled separately, so a duplicated literal is able to
 * drift apart silently and stall Desktop startup until the binding validation
 * times out.
 */
export const KNOWN_RENDERER_AGENTS = [
  "codex",
  "pi",
  "claude-code",
  "deepseek-harness",
  "opencode",
  "grok",
  "omp",
  "antigravity",
  "kiro-cli",
  "codebuddy",
  "workbuddy",
  "cursor-cli",
  "hermes",
  "qoder",
  "qoder-cn",
] as const;

export type RendererAgent = (typeof KNOWN_RENDERER_AGENTS)[number];

/**
 * The Agents the injected Renderer binding can offer in the Agent picker, in the
 * order the binding reports them.
 *
 * The production Desktop Controller validates the binding's reported list against
 * this exact sequence, so both sides must read it from here rather than repeating
 * the literal.
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
] as const;

export type RendererAgent = (typeof KNOWN_RENDERER_AGENTS)[number];

const DELEGATION_ENVIRONMENT_KEYS = [
  "CODEXHOST_CLI_PATH",
  "CODEXHOST_RUNTIME_ENDPOINT",
  "CODEXHOST_RUNTIME_TOKEN",
  "CODEXHOST_THREAD_ID",
] as const;

export const ANTIGRAVITY_DELEGATION_INSTRUCTIONS = `This Antigravity Session runs inside codexhost.
When the user requests cross-Harness delegation, use the executable specified by the CODEXHOST_CLI_PATH environment variable through your native shell tool. Use delegate start and thread send/read/wait/cancel as documented. Use --help or harness list when you need to discover commands or targets. Use --format compact for results. Keep the inherited CODEXHOST_RUNTIME_ENDPOINT, CODEXHOST_RUNTIME_TOKEN and CODEXHOST_THREAD_ID environment variables for every call; they identify this Runtime and parent Thread. Never print their values, substitute another executable, or delegate without user authorization. Native Antigravity subagents are separate from cross-Harness delegation.
For an explicit Model, Thinking level, or speed, read harness inspect --help and inspect the target. Pass the exact advertised Model Ref for the requested speed via --model and the Thinking option ID via --thinking. If a requested selection is unavailable, report it and ask before choosing a different one.`;

/** Only variable names enter the prompt; credentials remain in the process environment. */
export function antigravityDelegationInstructions(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  return DELEGATION_ENVIRONMENT_KEYS.every((key) => environment[key])
    ? ANTIGRAVITY_DELEGATION_INSTRUCTIONS
    : undefined;
}

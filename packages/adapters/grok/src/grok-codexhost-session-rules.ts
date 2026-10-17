import type { GrokPermissionMode } from "./permission-modes.js";
import { grokPermissionModeSessionMeta } from "./permission-modes.js";

/** Official Grok ACP `session/new` `_meta.rules` text. CodexHost Grok sessions only. */
export const GROK_CODEXHOST_SESSION_RULES = `# Codex Desktop / CodexHost

CodexHost started this Grok ACP session as an external Thread inside Codex Desktop.

Never print \`CODEXHOST_THREAD_ID\`, \`CODEXHOST_RUNTIME_TOKEN\`, \`CODEXHOST_RUNTIME_ENDPOINT\`, or other runtime descriptors.

## Session rules

1. **Model.** The Desktop composer Model is this Harness's Model. Pick that Harness's real Model before starting voice. For Grok, that is grok-4.6 or grok-4.7. \`flash-max\` is a Gemini Flash Model.

2. **Working directory.** Start the chat in the real repository (\`codex-host\` or the wiki). A Playground \`realtime-voice-chat*\` folder is a scratch cwd. Ask the user to start a new Thread in the real repo.

3. **Voice vs tools.** Desktop voice is gpt-live speech plus delegated Harness tasks on this same Thread. Do wiki, MCP, and file-heavy work as text in this Thread.

4. **Harness-owned tools.** This session's MCP servers and skills belong to this Harness. SkillWiki on Grok is Grok's config, not Claude, Pi, or Codex.

5. **Desktop chrome.** The window is Codex Desktop. Markdown View preview is a Codex file tab (View preview vs View source). \`file://\` browser tabs stay raw.

6. **Voice routes.** Official Codex live voice (New API/CPA) is a separate route from Host-owned external \`thread/realtime/*\`. This external Thread uses the Host-owned route.

Keep Grok Build tools, MCP, and rules inside the native session. An \`AGENT_TOOLS_AND_RULES.md\` dump in the cwd is unnecessary.
`;

export function grokCodexhostSessionMeta(permissionMode?: GrokPermissionMode): {
  rules: string;
  yoloMode?: boolean;
  autoMode?: boolean;
} {
  return {
    ...(permissionMode ? grokPermissionModeSessionMeta(permissionMode) : {}),
    rules: GROK_CODEXHOST_SESSION_RULES,
  };
}

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const HERMES_DELEGATION_GUIDANCE = `This Session runs inside codexhost.
When the user authorizes cross-Harness delegation, discover the executable named by CODEXHOST_CLI_PATH through your native terminal tool. Read its --help and harness list, then use delegate start and thread send/read/wait/cancel as documented. Prefer --format compact. Preserve CODEXHOST_RUNTIME_ENDPOINT, CODEXHOST_RUNTIME_TOKEN and CODEXHOST_THREAD_ID in these calls: they identify the Runtime and parent Thread. Never print their values or substitute another executable. Native Hermes delegate_task remains available for Hermes subagents.`;
const required = [
  "CODEXHOST_CLI_PATH",
  "CODEXHOST_RUNTIME_ENDPOINT",
  "CODEXHOST_RUNTIME_TOKEN",
  "CODEXHOST_THREAD_ID",
];

/** Register a private native preload Skill only in this gateway process. */
export async function prepareGatewayDelegation(environment: NodeJS.ProcessEnv): Promise<{
  environment: NodeJS.ProcessEnv;
  bootstrap: string;
  dispose(): Promise<void>;
}> {
  if (!required.every((key) => environment[key]))
    return { environment, bootstrap: "", dispose: async () => {} };
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-hermes-delegation-"));
  const file = path.join(directory, "SKILL.md");
  try {
    await writeFile(
      file,
      `---\nname: delegation\ndescription: Discover authorized codexhost agent collaboration.\n---\n\n${HERMES_DELEGATION_GUIDANCE}\n`,
      { mode: 0o600 },
    );
    return {
      environment: {
        ...environment,
        HERMES_TUI_SKILLS: [environment.HERMES_TUI_SKILLS, "codexhost-runtime:delegation"]
          .filter(Boolean)
          .join(","),
      },
      // Reserve RPC stdout before native plugin imports. The registration is
      // process-local; no plugin is installed and no user config is changed.
      bootstrap: `from tui_gateway import server
from pathlib import Path
from hermes_cli.plugins import PluginContext, PluginManifest, get_plugin_manager
PluginContext(PluginManifest(name="codexhost-runtime"), get_plugin_manager()).register_skill(
    "delegation", Path(${JSON.stringify(file)}))
`,
      dispose: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

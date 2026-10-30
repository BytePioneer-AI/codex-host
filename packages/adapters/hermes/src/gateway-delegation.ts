import { mkdir, rm, writeFile } from "node:fs/promises";
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

/**
 * Per-Thread delegation preload for the resident gateway.
 *
 * The executing agent lives in the gateway process, not in this bridge, so a
 * process-local `register_skill` never reaches it. Instead the preload is a
 * Thread-scoped SKILL.md that canonical `session.create` receives through its
 * `skills` parameter: the gateway loads it while building the session agent
 * (`build_preloaded_skills_prompt`), which is the process that actually runs
 * the turns. The file carries this Thread's real CODEXHOST identities — the
 * gateway process never sees the bridge environment — so it is written 0600
 * inside a 0700 per-Thread directory and removed when the bridge closes.
 */
export async function prepareGatewayDelegation(environment: NodeJS.ProcessEnv): Promise<{
  environment: NodeJS.ProcessEnv;
  bootstrap: string;
  /** SKILL.md path for canonical `session.create`'s `skills` parameter. */
  skillPath: string | null;
  dispose(): Promise<void>;
}> {
  if (!required.every((key) => environment[key]))
    return { environment, bootstrap: "", skillPath: null, dispose: async () => {} };
  // One directory per Thread: the file embeds Thread-scoped identities, so a
  // warm bridge from the pool reuses its own Thread's copy and a different
  // Thread never reads another one's credentials.
  const thread = String(environment.CODEXHOST_THREAD_ID).replace(/[^A-Za-z0-9._-]/gu, "_");
  const directory = path.join(os.tmpdir(), "codexhost-hermes-delegation", thread);
  const file = path.join(directory, "SKILL.md");
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      file,
      `---\nname: delegation\ndescription: Discover authorized codexhost agent collaboration.\n---\n\n${HERMES_DELEGATION_GUIDANCE}\n\nRuntime identity for this Thread:\n\n- CODEXHOST_CLI_PATH: ${environment.CODEXHOST_CLI_PATH}\n- CODEXHOST_RUNTIME_ENDPOINT: ${environment.CODEXHOST_RUNTIME_ENDPOINT}\n- CODEXHOST_RUNTIME_TOKEN: ${environment.CODEXHOST_RUNTIME_TOKEN}\n- CODEXHOST_THREAD_ID: ${environment.CODEXHOST_THREAD_ID}\n`,
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
      //
      // ``hermes_bootstrap`` must run before ``tui_gateway.server`` is imported:
      // the gateway spawn uses ``python -I``, so PYTHONPATH and the launcher's
      // activation are stripped. Hermes's own entry point (``tui_gateway/entry.py``)
      // imports this module first to put the selected dependency environment on
      // ``sys.path``; skipping it makes bare third-party imports (e.g.
      // ``hermes_yaml`` -> ``ruamel``) fail on interpreters whose site-packages
      // do not already carry Hermes's dependencies. ``hermes_bootstrap`` is
      // import-safe here for the same reason entry.py relies on it: stdlib-only
      // at import time, so nothing can shadow it from the launch directory.
      bootstrap: `import sys
import hermes_bootstrap
_stdout = sys.stdout  # tui_gateway.server redirects sys.stdout to sys.stderr at import (stdio-entry protection); this bridge owns stdout as its RPC channel to the host
from tui_gateway import server
sys.stdout = _stdout
`,
      skillPath: file,
      // The per-Thread file carries the Runtime token; remove it once the
      // bridge that owns this Thread goes away (the next open rewrites it).
      dispose: async () => {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (error) {
    throw error;
  }
}

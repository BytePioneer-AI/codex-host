/**
 * Per-Thread delegation guidance for the resident gateway.
 *
 * The executing agent lives in the gateway process, which never sees the
 * bridge environment — neither a process-local `register_skill` in the bridge
 * nor canonical create's `skills` parameter can reach it: the gateway's skill
 * lookup only resolves identifiers inside its own skill roots, and an absolute
 * path is refused with `unknown_skill` (verified against a live gateway). The
 * clean protocol channel is `prompt.submit`'s `api_text`: the model-facing
 * text when it differs from the persisted one, whose documented uses already
 * include skills-reload notes. The first turn of a delegation-enabled Session
 * submits the guidance as an api_text prefix — the agent reads the real
 * CODEXHOST identities while the persisted transcript keeps the user's text
 * verbatim. No file is written and no user config changes.
 */
export const HERMES_DELEGATION_GUIDANCE = `This Session runs inside codexhost.
When the user authorizes cross-Harness delegation, discover the executable named by CODEXHOST_CLI_PATH through your native terminal tool. Read its --help and harness list, then use delegate start and thread send/read/wait/cancel as documented. Prefer --format compact. Preserve CODEXHOST_RUNTIME_ENDPOINT, CODEXHOST_RUNTIME_TOKEN and CODEXHOST_THREAD_ID in these calls: they identify the Runtime and parent Thread. Never print their values or substitute another executable. Native Hermes delegate_task remains available for Hermes subagents.`;
const required = [
  "CODEXHOST_CLI_PATH",
  "CODEXHOST_RUNTIME_ENDPOINT",
  "CODEXHOST_RUNTIME_TOKEN",
  "CODEXHOST_THREAD_ID",
];

export async function prepareGatewayDelegation(environment: NodeJS.ProcessEnv): Promise<{
  environment: NodeJS.ProcessEnv;
  bootstrap: string;
  /**
   * Model-facing guidance prefix for this Thread's first prompt.submit
   * (api_text), or null when delegation is not active.
   */
  guidance: string | null;
  dispose(): Promise<void>;
}> {
  if (!required.every((key) => environment[key]))
    return { environment, bootstrap: "", guidance: null, dispose: async () => {} };
  return {
    environment,
    // Reserve RPC stdout before native plugin imports.
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
    guidance: `${HERMES_DELEGATION_GUIDANCE}

Runtime identity for this Thread:

- CODEXHOST_CLI_PATH: ${environment.CODEXHOST_CLI_PATH}
- CODEXHOST_RUNTIME_ENDPOINT: ${environment.CODEXHOST_RUNTIME_ENDPOINT}
- CODEXHOST_RUNTIME_TOKEN: ${environment.CODEXHOST_RUNTIME_TOKEN}
- CODEXHOST_THREAD_ID: ${environment.CODEXHOST_THREAD_ID}

(end of codexhost delegation note; the user's message follows)`,
    dispose: async () => {},
  };
}

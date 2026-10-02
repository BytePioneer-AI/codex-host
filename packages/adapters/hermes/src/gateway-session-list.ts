import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hermesPythonCommand, type HermesPythonRuntime } from "./hermes-runtime.js";

// Gateway session.list omits cwd and last_active. Use its native store's listing
// API in read-only mode, not session.resume (which would acquire a chat owner).
const SESSION_LIST_SCRIPT = String.raw`
import sys
output = sys.stdout
sys.stdout = sys.stderr
import json
from hermes_state import SessionDB, _default_db_path
from hermes_state_sessions import INTERNAL_LISTING_SOURCES
from hermes_cli.session_listing import show_subagent_sessions
p = json.load(sys.stdin)
result = []
try:
    _default_db_path().stat()
    exists = True
except FileNotFoundError:
    exists = False
if exists:
    db = SessionDB(read_only=True)
    try:
        rows = db.list_sessions_rich(
            limit=-1, order_by_last_active=True,
            exclude_sources=list(INTERNAL_LISTING_SOURCES),
            include_subagents=show_subagent_sessions(db.db_path.parent),
            id_query=p.get('nativeSessionId'),
        )
        for row in rows:
            # Keep the native lineage root used by Host mappings; a compression
            # continuation is not a new importable chat identity.
            sid = row.get('_lineage_root_id') or row['id']
            if p.get('nativeSessionId') and sid != p['nativeSessionId']:
                continue
            cwd = row.get('cwd')
            if not isinstance(cwd, str) or not cwd.strip():
                meta = row.get('model_config') or {}
                if isinstance(meta, str):
                    try: meta = json.loads(meta)
                    except (ValueError, TypeError): meta = {}
                cwd = meta.get('cwd') if isinstance(meta, dict) else None
            result.append({
                'id': sid, 'title': row.get('title'), 'cwd': cwd,
                'last_active': row.get('last_active') or row.get('started_at'),
            })
    finally:
        db.close()
output.write(json.dumps({'sessions': result}))
`;

export interface HermesSessionListOptions {
  runtime: HermesPythonRuntime;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  nativeSessionId?: string;
}

export async function readHermesSessions(options: HermesSessionListOptions): Promise<unknown[]> {
  const environment = { ...process.env, ...options.environment };
  options.signal?.throwIfAborted();
  const command = await hermesPythonCommand(
    options.runtime,
    SESSION_LIST_SCRIPT,
    environment,
    options.timeoutMs,
  );
  options.signal?.throwIfAborted();
  let stdout: string;
  try {
    const pending = promisify(execFile)(command.command, command.arguments, {
      cwd: options.cwd,
      env: environment,
      timeout: options.timeoutMs ?? 20_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      signal: options.signal,
    });
    pending.child.stdin?.on("error", () => undefined);
    pending.child.stdin?.end(JSON.stringify({ nativeSessionId: options.nativeSessionId }));
    // execFile reports AbortError before process close; wait for the owned
    // read-only process to exit before completing cancellation.
    const closed = new Promise<void>((resolve) => pending.child.once("close", () => resolve()));
    try {
      ({ stdout } = await pending);
    } finally {
      await closed;
    }
  } catch {
    // Native errors may contain configuration or transcript data. Never expose
    // the execFile error (which also embeds the bootstrap command and stderr).
    options.signal?.throwIfAborted();
    throw new Error("Cannot read Hermes native session metadata; source history was not modified");
  }
  options.signal?.throwIfAborted();
  let response: unknown;
  try {
    response = JSON.parse(stdout.trim());
  } catch {
    throw new Error("Malformed Hermes native session listing");
  }
  if (
    !response ||
    typeof response !== "object" ||
    !("sessions" in response) ||
    !Array.isArray(response.sessions)
  )
    throw new Error("Malformed Hermes native session listing");
  return response.sessions;
}

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const GOTGENES_WIDGET = "codexhost-gotgenes-subagents";
export const GOTGENES_PREFIX = "CODEXHOST_GOTGENES_SUBAGENTS_V1:";

/** Read-only bridge to the plugin's published SubagentsService. No tools or model calls. */
export const GOTGENES_EXTENSION = `export default function(pi) {
  let ctx, timer, service, previous = "";
  const publish = () => {
    if (!ctx) return;
    // Child SDK sessions can publish their own process-global service. Bind this parent once.
    if (!service) {
      const candidate = globalThis[Symbol.for("@gotgenes/pi-subagents:service")];
      if (typeof candidate?.listAgents !== "function") return;
      service = candidate;
    }
    const agents = service.listAgents().slice(0, 128).map((r) => ({
      id: r.id, type: r.type, description: r.description?.slice(0, 2048),
      status: r.status, isBackground: r.isBackground, outputFile: r.outputFile,
      toolUses: r.toolUses, startedAt: r.startedAt, completedAt: r.completedAt,
      result: r.result?.slice(0, 2048), error: r.error?.slice(0, 2048),
      turnBudget: r.turnBudget, lifetimeUsage: r.lifetimeUsage,
    }));
    const payload = JSON.stringify({version: 1, agents});
    if (payload === previous) return;
    previous = payload;
    ctx.ui.setWidget("${GOTGENES_WIDGET}", ["${GOTGENES_PREFIX}" + payload]);
  };
  const schedule = () => queueMicrotask(publish);
  for (const name of ["created", "started", "completed", "failed", "resuming", "resumed", "compacted", "steered", "update"]) {
    pi.events.on("subagents:" + name, schedule);
  }
  pi.on("session_start", (_event, context) => {
    // A session switch keeps this extension's manager/service; only reload creates a new instance.
    ctx = context; previous = ""; clearInterval(timer);
    schedule();
    // The public service publishes outputFile only after queued session creation and has no progress event.
    timer = setInterval(publish, 1000);
    timer.unref?.();
  });
  pi.on("session_shutdown", () => { clearInterval(timer); timer = undefined; ctx = undefined; service = undefined; });
}
`;

export async function ensureGotgenesExtension(environment: NodeJS.ProcessEnv): Promise<string> {
  const digest = createHash("sha256").update(GOTGENES_EXTENSION).digest("hex").slice(0, 16);
  const root =
    environment.CODEXHOST_DATA_DIR ??
    path.join(environment.HOME ?? environment.USERPROFILE ?? homedir(), ".codexhost");
  const directory = path.resolve(root, "extensions", "pi-subagent-observer");
  const file = path.join(directory, `${digest}.mjs`);
  if ((await readFile(file, "utf8").catch(() => "")) === GOTGENES_EXTENSION) return file;
  await mkdir(directory, { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, GOTGENES_EXTENSION, { mode: 0o600 });
    try {
      await rename(temporary, file);
    } catch (error) {
      if ((await readFile(file, "utf8").catch(() => "")) !== GOTGENES_EXTENSION) throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return file;
}

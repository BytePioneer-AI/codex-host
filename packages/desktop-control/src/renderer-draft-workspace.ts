import { committedReactAncestors } from "./renderer-react-ownership.js";
import { readNativeScheduleWorkspaces } from "./renderer-schedule-workspace.js";
import type { RendererHostRoot } from "./renderer-host-discovery.js";

/** Read the committed native project selection before Desktop issues a prewarm.
 * Undefined means this layout has no observable draft; null revokes an old path.
 * Self-contained for Controller injection, with explicit discovery dependencies. */
export function readRendererLocalDraftWorkspace(
  root: RendererHostRoot,
  ancestors: typeof committedReactAncestors = committedReactAncestors,
  workspaces: typeof readNativeScheduleWorkspaces = readNativeScheduleWorkspaces,
): string | null | undefined {
  const record = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const selections = new Set<string | null>();
  let workspaceCatalog: ReturnType<typeof workspaces> | undefined;
  for (const editor of root.querySelectorAll(
    '[data-codex-composer], [contenteditable="true"][role="textbox"]',
  )) {
    let element: RendererHostRoot | null = editor;
    let fiber: unknown;
    while (element && !fiber) {
      const keys = Object.getOwnPropertyNames(element).filter((k) => k.startsWith("__reactFiber$"));
      const key = keys[0];
      if (keys.length === 1 && key) fiber = Reflect.get(element, key);
      element = element.parentElement ?? null;
    }
    const props = ancestors(fiber).flatMap((f) =>
      record(f.memoizedProps) ? [f.memoizedProps] : [],
    );
    const hosts = new Set(
      props
        .flatMap((p) => [p.executionTargetHostId, p.permissionsHostId])
        .filter((v) => typeof v === "string"),
    );
    if (hosts.size !== 1 || !hosts.has("local")) continue;
    const draft = props.find(
      (p) =>
        typeof p.browserConversationId === "string" &&
        p.browserConversationId.startsWith("client-new-thread:") &&
        "selectedProject" in p,
    );
    if (!draft) continue;
    const project = draft.selectedProject;
    if (!record(project) || project.type !== "local" || typeof project.projectId !== "string") {
      selections.add(null);
      continue;
    }
    const matches = (workspaceCatalog ??= workspaces(root)).filter(
      (w) => w.id === project.projectId,
    );
    selections.add(matches.length === 1 ? (matches[0]?.cwd ?? null) : null);
  }
  return selections.size === 0 ? undefined : selections.size === 1 ? [...selections][0] : null;
}

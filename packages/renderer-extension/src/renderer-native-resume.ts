import type { RendererHostRoute } from "@codexhost/desktop-control/renderer-bindings";
import { installRendererManagerMethods } from "./renderer-manager-methods.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function installRendererNativeResume(
  target: RendererHostRoute["manager"],
  isCurrent: () => boolean,
): (() => void) | null {
  const original = target.resumeThread;
  if (!original || !target.updateConversationState) return null;
  let disposed = false;
  const resume = function (params: unknown): Promise<unknown> {
    return original.call(target, params).then((result) => {
      if (
        !disposed &&
        isCurrent() &&
        isRecord(params) &&
        isRecord(result) &&
        isRecord(result.thread) &&
        result.thread.id === params.threadId &&
        typeof result.thread.id === "string" &&
        typeof result.modelProvider === "string" &&
        result.modelProvider !== "codexhost"
      ) {
        // Correct Desktop's historical converter after every native resume,
        // including Sidebar/cold-start paths outside the extension's client.
        const modelProvider = result.modelProvider;
        const model = typeof result.model === "string" ? result.model : null;
        target.updateConversationState?.(result.thread.id, (conversation) => {
          conversation.modelProvider = modelProvider;
          if (model) {
            conversation.latestModel = model;
            const collaboration = conversation.latestCollaborationMode;
            if (isRecord(collaboration) && isRecord(collaboration.settings)) {
              conversation.latestCollaborationMode = {
                ...collaboration,
                settings: { ...collaboration.settings, model },
              };
            }
            if (isRecord(conversation.latestThreadSettings)) {
              conversation.latestThreadSettings = {
                ...conversation.latestThreadSettings,
                model,
              };
            }
          }
        });
      }
      return result;
    });
  };
  const restore = installRendererManagerMethods(target, { resumeThread: resume });
  return () => {
    disposed = true;
    restore("resumeThread");
  };
}

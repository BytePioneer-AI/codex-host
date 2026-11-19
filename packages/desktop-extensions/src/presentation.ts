import type {
  DesktopExtensionApiV1,
  ThreadTreeNode,
  ThreadTreeStatus,
} from "@codexhost/shared-contracts";

export const statusPriority: Record<ThreadTreeStatus, number> = {
  waiting: 0,
  running: 1,
  unknown: 2,
  idle: 3,
};

export const statusLabel: Record<ThreadTreeStatus, string> = {
  waiting: "Needs attention",
  running: "Running",
  unknown: "Status unknown",
  idle: "Idle",
};

export function appendThreadLabel(
  api: DesktopExtensionApiV1,
  button: HTMLButtonElement,
  threadId: string,
  thread: ThreadTreeNode,
): void {
  const harness = api.harnesses.describe(thread.harnessId);
  const document = button.ownerDocument;
  if (harness?.icon) {
    const icon = document.createElement("img");
    icon.src = harness.icon;
    icon.alt = "";
    button.append(icon);
  }
  const title = document.createElement("span");
  title.textContent = thread.title || threadId;
  button.append(title);
  button.dataset.state = thread.status;
  button.title = `${title.textContent} — ${harness?.name ?? thread.harnessId} · ${statusLabel[thread.status]}`;
  button.setAttribute("aria-label", button.title);
}

export async function openThread(api: DesktopExtensionApiV1, id: string): Promise<void> {
  try {
    await api.navigate.openThread(id);
  } catch (error) {
    if (!api.signal.aborted) console.warn("Cannot open the local Thread", error);
  }
}

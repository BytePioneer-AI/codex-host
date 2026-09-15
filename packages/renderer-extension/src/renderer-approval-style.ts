export function installRendererApprovalStyle(ownerDocument: Document): () => void {
  ownerDocument.querySelector("style[data-codexhost-approval-style]")?.remove();
  const style = ownerDocument.createElement("style");
  style.setAttribute("data-codexhost-approval-style", "true");
  style.textContent = `
    [data-codex-approval-surface] > form {
      justify-content: flex-end;
    }
    [data-codex-approval-surface] > form > .ms-auto {
      margin-inline-start: 0;
    }
  `;
  (ownerDocument.head ?? ownerDocument.documentElement).append(style);
  return () => style.remove();
}

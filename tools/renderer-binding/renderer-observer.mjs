const INSTALL_RENDERER_OBSERVER_SOURCE = `(() => {
  window.__codexhostRendererBindingObserverV1?.dispose?.();
  const observations = [];
  const switchCounters = { attempts: 0, committed: 0, rejected: 0 };
  let submissionSequence = 0;
  let lastSubmission = null;
  let disposed = false;

  const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
  const submission = (event) => {
    const detail = event.detail;
    if (
      !isRecord(detail) ||
      typeof detail.composerId !== 'string' ||
      !['codex', 'pi', 'claude-code'].includes(detail.agent) ||
      !['click', 'enter', 'submit'].includes(detail.trigger)
    ) return;
    const capturedAt = Date.now();
    if (
      lastSubmission != null &&
      lastSubmission.composerId === detail.composerId &&
      lastSubmission.agent === detail.agent &&
      capturedAt - lastSubmission.capturedAt <= 250
    ) return;
    lastSubmission = { composerId: detail.composerId, agent: detail.agent, capturedAt };
    observations.push({
      submissionId: 'tooling-submission-' + (++submissionSequence),
      composerId: detail.composerId,
      agent: detail.agent,
      trigger: detail.trigger,
      capturedAt: new Date(capturedAt).toISOString(),
    });
    if (observations.length > 50) observations.shift();
  };

  const settleSwitch = async (composerId, agent) => {
    const selector = '[data-codexhost-agent-control="' + CSS.escape(composerId) + '"]';
    const deadline = Date.now() + 10_000;
    while (!disposed && Date.now() < deadline) {
      const control = document.querySelector(selector);
      if (control == null) break;
      const selected = control.querySelector('button[data-agent="' + agent + '"]');
      if (selected?.getAttribute('aria-pressed') === 'true') {
        switchCounters.committed += 1;
        return;
      }
      const buttons = [...control.querySelectorAll('button[data-agent]')];
      if (buttons.length >= 2 && buttons.some((button) => !button.disabled)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    switchCounters.rejected += 1;
  };

  const agentClick = (event) => {
    const target = event.target instanceof Element
      ? event.target.closest('button[data-agent]')
      : null;
    const control = target?.closest('[data-codexhost-agent-control]');
    const agent = target?.dataset.agent;
    const composerId = control?.getAttribute('data-codexhost-agent-control');
    if (
      target == null ||
      target.disabled ||
      target.getAttribute('aria-pressed') === 'true' ||
      !['codex', 'pi', 'claude-code'].includes(agent) ||
      typeof composerId !== 'string'
    ) return;
    switchCounters.attempts += 1;
    setTimeout(() => void settleSwitch(composerId, agent), 0);
  };

  const diagnostics = () => {
    const editorSelector = 'textarea, [contenteditable="true"], [role="textbox"]';
    const diagnosticSelector = '[placeholder], [data-placeholder], [contenteditable], [role="textbox"]';
    const candidates = [...document.querySelectorAll(diagnosticSelector)].slice(0, 12);
    const elementShape = (element) => ({
      tagName: element.tagName.toLowerCase(),
      attributeNames: element.getAttributeNames().sort(),
      tabIndex: element instanceof HTMLElement ? element.tabIndex : -1,
    });
    const bottomCenterStack = document
      .elementsFromPoint(window.innerWidth / 2, Math.max(0, window.innerHeight - 90))
      .slice(0, 12)
      .map((element) => ({
        ...elementShape(element),
        contentEditable: element instanceof HTMLElement ? element.contentEditable : 'inherit',
      }));
    const bottomFocusable = [...document.querySelectorAll('*')]
      .filter((element) => {
        const bounds = element.getBoundingClientRect();
        return element.tabIndex >= 0 && bounds.top >= window.innerHeight * 0.65 && bounds.height > 0;
      })
      .slice(0, 20)
      .map(elementShape);
    return {
      editorCandidates: document.querySelectorAll(editorSelector).length,
      shapes: candidates.map((candidate) => {
        const ancestorTags = [];
        const ancestorButtonCounts = [];
        let ancestor = candidate;
        for (let depth = 0; ancestor && ancestor !== document.body && depth < 6; depth += 1) {
          ancestorTags.push(ancestor.tagName.toLowerCase());
          ancestorButtonCounts.push(ancestor.querySelectorAll('button').length);
          ancestor = ancestor.parentElement;
        }
        return {
          tagName: candidate.tagName.toLowerCase(),
          role: candidate.getAttribute('role'),
          contentEditable: candidate.getAttribute('contenteditable'),
          hasPlaceholder: candidate.hasAttribute('placeholder'),
          hasDataPlaceholder: candidate.hasAttribute('data-placeholder'),
          ancestorTags,
          ancestorButtonCounts,
        };
      }),
      bottomCenterStack,
      bottomFocusable,
    };
  };

  window.addEventListener('codexhost:renderer-submission', submission);
  document.addEventListener('click', agentClick, true);
  const api = Object.freeze({
    status() {
      return {
        version: 1,
        switchCounters: { ...switchCounters },
        observations: observations.map((value) => ({ ...value })),
        diagnostics: diagnostics(),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('codexhost:renderer-submission', submission);
      document.removeEventListener('click', agentClick, true);
      if (window.__codexhostRendererBindingObserverV1 === api) {
        delete window.__codexhostRendererBindingObserverV1;
      }
    },
  });
  Object.defineProperty(window, '__codexhostRendererBindingObserverV1', {
    configurable: true,
    value: api,
  });
  return api.status();
})()`;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateRendererObserverStatus(value) {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isRecord(value.switchCounters) ||
    !Number.isInteger(value.switchCounters.attempts) ||
    !Number.isInteger(value.switchCounters.committed) ||
    !Number.isInteger(value.switchCounters.rejected) ||
    value.switchCounters.committed + value.switchCounters.rejected >
      value.switchCounters.attempts ||
    !Array.isArray(value.observations) ||
    !isRecord(value.diagnostics) ||
    !Number.isInteger(value.diagnostics.editorCandidates) ||
    !Array.isArray(value.diagnostics.shapes)
  ) {
    throw new Error("Renderer tooling observer returned an invalid status");
  }
  for (const observation of value.observations) {
    if (
      !isRecord(observation) ||
      typeof observation.submissionId !== "string" ||
      typeof observation.composerId !== "string" ||
      !["codex", "pi", "claude-code"].includes(observation.agent) ||
      !["click", "enter", "submit"].includes(observation.trigger) ||
      typeof observation.capturedAt !== "string"
    ) {
      throw new Error("Renderer tooling observer returned an invalid observation");
    }
  }
  return value;
}

export async function installRendererObserver(executeInRenderer) {
  return validateRendererObserverStatus(await executeInRenderer(INSTALL_RENDERER_OBSERVER_SOURCE));
}

export async function readRendererObserver(executeInRenderer) {
  return validateRendererObserverStatus(
    await executeInRenderer("window.__codexhostRendererBindingObserverV1?.status() ?? null"),
  );
}

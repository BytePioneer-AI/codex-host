export interface RendererDomNodeSummary {
  nodeName: string;
  attributeNames: string[];
  reasons: string[];
  ancestorNames: string[];
}

export interface RendererShadowRootSummary {
  shadowRootType: "open";
  childNodeCount: number;
}

export interface RendererDomInspection {
  totalNodes: number;
  nodeNameCounts: Record<string, number>;
  shadowRoots: RendererShadowRootSummary[];
  editorCandidates: RendererDomNodeSummary[];
  sendButtonCandidates: RendererDomNodeSummary[];
}

interface RendererRuntimeClient {
  evaluate<T>(expression: string): Promise<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Renderer DOM inspection '${field}' must be a text array`);
  }
  return [...value];
}

function nodeSummary(value: unknown): RendererDomNodeSummary {
  if (!isRecord(value) || typeof value.nodeName !== "string") {
    throw new Error("Renderer DOM inspection candidate must be an object");
  }
  return {
    nodeName: value.nodeName,
    attributeNames: stringArray(value.attributeNames, "attributeNames"),
    reasons: stringArray(value.reasons, "reasons"),
    ancestorNames: stringArray(value.ancestorNames, "ancestorNames"),
  };
}

export function validateRendererDomInspection(value: unknown): RendererDomInspection {
  if (
    !isRecord(value) ||
    !Number.isInteger(value.totalNodes) ||
    !isRecord(value.nodeNameCounts) ||
    !Array.isArray(value.shadowRoots) ||
    !Array.isArray(value.editorCandidates) ||
    !Array.isArray(value.sendButtonCandidates)
  ) {
    throw new Error("Renderer DOM inspection returned an invalid result");
  }
  const nodeNameCounts: Record<string, number> = {};
  for (const [name, count] of Object.entries(value.nodeNameCounts)) {
    if (!Number.isInteger(count)) {
      throw new Error("Renderer DOM inspection node counts must be integers");
    }
    nodeNameCounts[name] = count as number;
  }
  const shadowRoots = value.shadowRoots.map((shadowRoot) => {
    if (
      !isRecord(shadowRoot) ||
      shadowRoot.shadowRootType !== "open" ||
      !Number.isInteger(shadowRoot.childNodeCount)
    ) {
      throw new Error("Renderer DOM inspection returned an invalid shadow root");
    }
    return {
      shadowRootType: "open" as const,
      childNodeCount: shadowRoot.childNodeCount as number,
    };
  });
  return {
    totalNodes: value.totalNodes as number,
    nodeNameCounts,
    shadowRoots,
    editorCandidates: value.editorCandidates.map(nodeSummary),
    sendButtonCandidates: value.sendButtonCandidates.map(nodeSummary),
  };
}

const rendererStructureExpression = `(() => {
  const result = {
    totalNodes: 0,
    nodeNameCounts: {},
    shadowRoots: [],
    editorCandidates: [],
    sendButtonCandidates: [],
  };
  const summarize = (element, reasons, ancestors) => ({
    nodeName: element.nodeName.toLowerCase(),
    attributeNames: element.getAttributeNames().sort(),
    reasons,
    ancestorNames: ancestors.slice(-8),
  });
  const visit = (node, ancestors) => {
    result.totalNodes += 1;
    const nodeName = node.nodeName.toLowerCase();
    result.nodeNameCounts[nodeName] = (result.nodeNameCounts[nodeName] ?? 0) + 1;
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node;
    const editorReasons = [];
    if (nodeName === 'textarea') editorReasons.push('textarea');
    if (nodeName === 'input' && element.getAttribute('type') !== 'hidden') editorReasons.push('input');
    if (element.hasAttribute('contenteditable')) editorReasons.push('contenteditable');
    if (element.getAttribute('role') === 'textbox') editorReasons.push('role=textbox');
    for (const attribute of ['data-lexical-editor', 'data-slate-editor', 'data-placeholder']) {
      if (element.hasAttribute(attribute)) editorReasons.push(attribute);
    }
    if (editorReasons.length > 0) {
      result.editorCandidates.push(summarize(element, editorReasons, ancestors));
    }
    if (nodeName === 'button' && element.getAttribute('type') === 'submit') {
      result.sendButtonCandidates.push(summarize(element, ['type=submit'], ancestors));
    }
    const nextAncestors = [...ancestors, nodeName];
    for (const child of element.children) visit(child, nextAncestors);
    if (element.shadowRoot) {
      result.shadowRoots.push({
        shadowRootType: 'open',
        childNodeCount: element.shadowRoot.childElementCount,
      });
      for (const child of element.shadowRoot.children) visit(child, nextAncestors);
    }
    if (nodeName === 'template' && element.content) {
      for (const child of element.content.children) visit(child, nextAncestors);
    }
  };
  visit(document.documentElement, []);
  return result;
})()`;

export async function inspectRendererDom(
  client: RendererRuntimeClient,
): Promise<RendererDomInspection> {
  const inspection = await client.evaluate<unknown>(rendererStructureExpression);
  return validateRendererDomInspection(inspection);
}

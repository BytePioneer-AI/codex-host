import codexAgentIconUrl from "./assets/codex-agent.png";
import type { RendererAgent } from "./agent-selection-state.js";

export const RENDERER_AGENT_LABELS: Record<RendererAgent, string> = {
  codex: "Codex",
  pi: "Pi",
  "claude-code": "Claude Code",
};

const PI_PATHS = [
  {
    d: "M1 1h16.5v11H12v5.5H6.5V23H1V1zm5.5 5.5V12H12V6.5H6.5z",
    fillRule: "evenodd",
  },
  { d: "M17.5 12H23v11h-5.5V12z" },
] as const;

const CLAUDE_PATH =
  "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z";

function createSvgIcon(
  paths: readonly { d: string; fillRule?: string }[],
  color: string,
  size: number,
  ownerDocument: Document,
): SVGSVGElement {
  const svg = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.style.width = `${size}px`;
  svg.style.height = `${size}px`;
  svg.style.flex = "none";
  svg.style.fill = color;
  for (const definition of paths) {
    const path = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", definition.d);
    if (definition.fillRule) path.setAttribute("fill-rule", definition.fillRule);
    svg.append(path);
  }
  return svg;
}

export function createRendererAgentIcon(
  agent: RendererAgent,
  size = 20,
  ownerDocument: Document = document,
): Element {
  if (agent === "codex") {
    const image = ownerDocument.createElement("img");
    image.src = codexAgentIconUrl;
    image.alt = "";
    image.draggable = false;
    image.style.width = `${size}px`;
    image.style.height = `${size}px`;
    image.style.objectFit = "contain";
    image.style.flex = "none";
    return image;
  }
  if (agent === "pi") return createSvgIcon(PI_PATHS, "currentColor", size, ownerDocument);
  return createSvgIcon([{ d: CLAUDE_PATH }], "#d97757", size, ownerDocument);
}

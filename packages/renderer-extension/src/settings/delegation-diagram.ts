import type { HarnessPluginDescriptor } from "@codexhost/shared-contracts";
import { createRendererAgentIcon } from "../renderer-agent-icon.js";
import type { DelegationMessages } from "./delegation-messages.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const RING_RADIUS = 16.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const COMET_TAIL_LENGTH = 72;
const TRAVEL_SECONDS = 0.92;
const RESET_AT_SECONDS = 8.45;
const CYCLE_SECONDS = 9.35;
const REDUCED_MOTION_SNAPSHOT_SECONDS = 7.2;

const LANE_SCHEDULES = [
  { d: 0.28, run: 2.25 }, // Lane 0 (finishes 2nd)
  { d: 0.44, run: 2.95 }, // Lane 1 (finishes 3rd)
  { d: 0.58, run: 1.38 }, // Lane 2 (finishes 1st)
].map((entry) => ({
  ...entry,
  arr: entry.d + TRAVEL_SECONDS,
  fin: entry.d + TRAVEL_SECONDS + entry.run,
  back: entry.d + TRAVEL_SECONDS + entry.run + TRAVEL_SECONDS,
}));

const FEED_ORDER = [2, 0, 1] as const;

const AGENT_DOT_COLORS: Record<string, string> = {
  codex: "light-dark(#27272a, #d4d4d8)",
  "claude-code": "light-dark(#c96a46, #e28d6b)",
  antigravity: "light-dark(#5b63d3, #8c95f7)",
  pi: "light-dark(#2b8a6e, #4eb897)",
  grok: "light-dark(#1c859c, #48b8d0)",
  opencode: "light-dark(#b07834, #d8a25e)",
};

const FALLBACK_DOT_PALETTE = [
  "light-dark(#7c5cbf, #a98ef0)",
  "light-dark(#2b8a6e, #4eb897)",
  "light-dark(#c96a46, #e28d6b)",
  "light-dark(#1c859c, #48b8d0)",
  "light-dark(#b07834, #d8a25e)",
] as const;

export function delegationAgentDotColor(harnessId: string): string {
  const known = AGENT_DOT_COLORS[harnessId];
  if (known) return known;
  let hash = 0;
  for (let index = 0; index < harnessId.length; index++) {
    hash = (hash * 31 + harnessId.charCodeAt(index)) >>> 0;
  }
  return FALLBACK_DOT_PALETTE[hash % FALLBACK_DOT_PALETTE.length] ?? FALLBACK_DOT_PALETTE[0];
}

export interface DelegationDiagramAgent {
  readonly id: string;
  readonly name: string;
  readonly plugin?: HarnessPluginDescriptor | undefined;
  readonly modelText: string;
  readonly overridden: boolean;
}

export interface DelegationDiagramController {
  readonly element: HTMLElement;
  updateAgents(agents: readonly DelegationDiagramAgent[]): void;
  dispose(): void;
}

interface WireNodes {
  readonly grad: SVGLinearGradientElement;
  readonly grp: SVGGElement;
  readonly base: SVGPathElement;
  readonly comet: SVGPathElement;
  readonly halo: SVGCircleElement;
  readonly head: SVGCircleElement;
  length: number;
}

interface LaneNodes {
  readonly root: HTMLElement;
  readonly inDot: HTMLElement;
  readonly outDot: HTMLElement;
  readonly prg: SVGCircleElement;
  readonly mark: HTMLElement;
  readonly dot: HTMLElement;
  readonly name: HTMLElement;
  readonly model: HTMLElement;
  readonly state: HTMLElement;
  agentSignature: string;
}

interface FeedNodes {
  readonly root: HTMLElement;
  readonly meta: HTMLElement;
  readonly agent: HTMLElement;
  readonly duration: string;
  readonly laneIndex: number;
}

const FALLBACK_LANE_AGENTS = [
  { id: "claude-code", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "grok", name: "Grok" },
] as const;

function createSvgElement<K extends keyof SVGElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs?: Record<string, string>,
): SVGElementTagNameMap[K] {
  const el = doc.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      el.setAttribute(key, value);
    }
  }
  return el;
}

function createFallbackMark(doc: Document, harnessId: string): SVGSVGElement {
  const svg = createSvgElement(doc, "svg", {
    viewBox: "0 0 20 20",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.5",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  });
  if (harnessId === "claude-code") {
    svg.append(createSvgElement(doc, "path", { d: "M10 3v14M3.9 6.5l12.2 7M16.1 6.5l-12.2 7" }));
  } else if (harnessId === "grok") {
    svg.append(
      createSvgElement(doc, "circle", { cx: "10", cy: "10", r: "6" }),
      createSvgElement(doc, "path", { d: "M5.2 14.8l9.6-9.6" }),
    );
  } else if (harnessId === "codex") {
    svg.append(createSvgElement(doc, "path", { d: "M5 6.5L9.5 10 5 13.5M11.5 13.5H16" }));
  } else {
    svg.append(createSvgElement(doc, "path", { d: "M10 3.2L16.2 15.6 10 12.6 3.8 15.6 10 3.2z" }));
  }
  return svg;
}

function toggleClass(el: Element, className: string, force: boolean): void {
  if (el.classList && typeof el.classList.toggle === "function") {
    el.classList.toggle(className, force);
    return;
  }
  const current = new Set(
    (el.getAttribute("class") ?? el.className ?? "").toString().split(/\s+/u).filter(Boolean),
  );
  if (force) current.add(className);
  else current.delete(className);
  const next = [...current].join(" ");
  if (typeof el.setAttribute === "function") el.setAttribute("class", next);
}

function cubicEase(progress: number): number {
  return progress < 0.5
    ? 4 * progress * progress * progress
    : 1 - Math.pow(-2 * progress + 2, 3) / 2;
}

/**
 * Selects 3 lanes for the illustrative 1 -> 3 -> 1 diagram, preferring the user's
 * ready agents (putting codex in the middle lane when present so the visual
 * matches the 8792 layout) and filling any remaining slots with illustrative defaults.
 */
export function selectDiagramLanes(
  readyAgents: readonly DelegationDiagramAgent[],
  defaultModelText: string,
): readonly DelegationDiagramAgent[] {
  const byId = new Map(readyAgents.map((agent) => [agent.id, agent]));
  const picked: DelegationDiagramAgent[] = [];
  const used = new Set<string>();

  const take = (agent: DelegationDiagramAgent | undefined): void => {
    if (!agent || used.has(agent.id)) return;
    used.add(agent.id);
    picked.push(agent);
  };

  // Prefer Claude Code in lane 0, Codex in lane 1, and another ready agent in lane 2.
  const claude = byId.get("claude-code");
  const codex = byId.get("codex");
  const grok = byId.get("grok");
  const others = readyAgents.filter(
    (agent) => agent.id !== "claude-code" && agent.id !== "codex" && agent.id !== "grok",
  );

  const slot0 = claude ??
    others[0] ??
    grok ?? {
      ...FALLBACK_LANE_AGENTS[0],
      modelText: defaultModelText,
      overridden: false,
    };
  take(slot0);

  const slot1 = codex ??
    others.find((agent) => !used.has(agent.id)) ?? {
      ...FALLBACK_LANE_AGENTS[1],
      modelText: defaultModelText,
      overridden: false,
    };
  take(slot1);

  const slot2 =
    (!used.has("grok") ? grok : undefined) ??
    others.find((agent) => !used.has(agent.id)) ??
    FALLBACK_LANE_AGENTS.find((fallback) => !used.has(fallback.id)) ??
    FALLBACK_LANE_AGENTS[2];
  const resolvedSlot2: DelegationDiagramAgent =
    "modelText" in slot2 ? slot2 : { ...slot2, modelText: defaultModelText, overridden: false };
  take(resolvedSlot2);

  return [slot0, slot1, resolvedSlot2];
}

let gradientCounter = 0;

export function createDelegationDiagram(
  doc: Document,
  messages: DelegationMessages,
  initialAgents: readonly DelegationDiagramAgent[],
): DelegationDiagramController {
  const ownerWindow = doc.defaultView;
  const uid = ++gradientCounter;

  const hero = doc.createElement("section");
  hero.className = "settings-delegation__hero";
  hero.setAttribute("aria-label", messages.heroAriaLabel);

  const diagram = doc.createElement("div");
  diagram.className = "settings-delegation__diagram";
  hero.append(diagram);

  const svg = createSvgElement(doc, "svg", {
    class: "settings-delegation__wires",
    "aria-hidden": "true",
  });
  const defs = createSvgElement(doc, "defs");
  svg.append(defs);
  diagram.append(svg);

  // Left: Origin column
  const originCol = doc.createElement("div");
  originCol.className = "settings-delegation__col settings-delegation__col--origin";
  const originEyebrow = doc.createElement("span");
  originEyebrow.className = "settings-delegation__eyebrow";
  originEyebrow.textContent = messages.eyebrowOrigin;

  const originNode = doc.createElement("div");
  originNode.className = "settings-delegation__origin-node";
  const originBody = doc.createElement("div");
  originBody.className = "settings-delegation__origin-body";
  const originTitleRow = doc.createElement("div");
  originTitleRow.className = "settings-delegation__origin-title-row";
  const originIcon = createSvgElement(doc, "svg", {
    class: "settings-delegation__origin-icon",
    viewBox: "0 0 22 22",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.55",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  });
  originIcon.append(
    createSvgElement(doc, "rect", { x: "2.5", y: "2.5", width: "17", height: "17", rx: "4.5" }),
    createSvgElement(doc, "circle", {
      cx: "11",
      cy: "11",
      r: "2.2",
      fill: "var(--dlg-accent)",
      stroke: "none",
    }),
  );
  const originTitle = doc.createElement("span");
  originTitle.className = "settings-delegation__node-title";
  originTitle.textContent = messages.originTitle;
  originTitleRow.append(originIcon, originTitle);

  const originSub = doc.createElement("div");
  originSub.className = "settings-delegation__node-sub";
  originSub.textContent = messages.originSubtitle;
  originBody.append(originTitleRow, originSub);

  const originDot = doc.createElement("span");
  originDot.className = "settings-delegation__origin-dot";
  originDot.setAttribute("aria-hidden", "true");
  originNode.append(originBody, originDot);
  originCol.append(originEyebrow, originNode);

  // Center: 3 Parallel Lanes
  const lanesCol = doc.createElement("div");
  lanesCol.className = "settings-delegation__col settings-delegation__col--lanes";
  const lanesEyebrow = doc.createElement("span");
  lanesEyebrow.className = "settings-delegation__eyebrow";
  lanesEyebrow.textContent = messages.eyebrowLanes;
  lanesCol.append(lanesEyebrow);

  const laneNodes: LaneNodes[] = LANE_SCHEDULES.map((_, index) => {
    const lane = doc.createElement("div");
    lane.className = "settings-delegation__lane";
    lane.dataset.lane = String(index);

    const inDot = doc.createElement("span");
    inDot.className = "settings-delegation__lane-pt settings-delegation__lane-in";
    inDot.setAttribute("aria-hidden", "true");

    const ring = doc.createElement("div");
    ring.className = "settings-delegation__ring";
    const ringSvg = createSvgElement(doc, "svg", {
      class: "settings-delegation__ring-svg",
      viewBox: "0 0 36 36",
      "aria-hidden": "true",
    });
    const trk = createSvgElement(doc, "circle", {
      class: "settings-delegation__ring-trk",
      cx: "18",
      cy: "18",
      r: String(RING_RADIUS),
    });
    const prg = createSvgElement(doc, "circle", {
      class: "settings-delegation__ring-prg",
      cx: "18",
      cy: "18",
      r: String(RING_RADIUS),
    });
    ringSvg.append(trk, prg);
    const mark = doc.createElement("span");
    mark.className = "settings-delegation__ring-mark";
    mark.setAttribute("aria-hidden", "true");
    ring.append(ringSvg, mark);

    const main = doc.createElement("div");
    main.className = "settings-delegation__lane-main";
    const top = doc.createElement("div");
    top.className = "settings-delegation__lane-top";
    const who = doc.createElement("span");
    who.className = "settings-delegation__lane-who";
    const dot = doc.createElement("span");
    dot.className = "settings-delegation__dot";
    const name = doc.createElement("span");
    name.className = "settings-delegation__lane-name";
    who.append(dot, name);
    const model = doc.createElement("span");
    model.className = "settings-delegation__lane-model";
    top.append(who, model);

    const bottom = doc.createElement("div");
    bottom.className = "settings-delegation__lane-bottom";
    const task = doc.createElement("span");
    task.className = "settings-delegation__lane-task";
    task.textContent = messages.laneTasks[index] ?? "";
    const state = doc.createElement("span");
    state.className = "settings-delegation__lane-state";
    state.textContent = messages.stateWaiting;
    bottom.append(task, state);
    main.append(top, bottom);

    const outDot = doc.createElement("span");
    outDot.className = "settings-delegation__lane-pt settings-delegation__lane-out";
    outDot.setAttribute("aria-hidden", "true");

    lane.append(inDot, ring, main, outDot);
    lanesCol.append(lane);
    return {
      root: lane,
      inDot,
      outDot,
      prg,
      mark,
      dot,
      name,
      model,
      state,
      agentSignature: "",
    };
  });

  // Right: Return Convergence + Async Feed
  const returnCol = doc.createElement("div");
  returnCol.className = "settings-delegation__col settings-delegation__col--return";
  const returnEyebrow = doc.createElement("span");
  returnEyebrow.className = "settings-delegation__eyebrow";
  returnEyebrow.textContent = messages.eyebrowReturn;

  const returnWrap = doc.createElement("div");
  returnWrap.className = "settings-delegation__return-wrap";
  const cvDot = doc.createElement("span");
  cvDot.className = "settings-delegation__cv-dot";
  cvDot.setAttribute("aria-hidden", "true");
  const cvPulses = LANE_SCHEDULES.map(() => {
    const pulse = doc.createElement("i");
    pulse.className = "settings-delegation__cv-pulse";
    cvDot.append(pulse);
    return pulse;
  });

  const returnPanel = doc.createElement("div");
  returnPanel.className = "settings-delegation__return-panel";
  const cvHead = doc.createElement("div");
  cvHead.className = "settings-delegation__cv-head";
  const cvTitle = doc.createElement("div");
  cvTitle.className = "settings-delegation__node-title";
  cvTitle.textContent = messages.returnTitle;
  const cvSub = doc.createElement("div");
  cvSub.className = "settings-delegation__cv-sub";
  cvSub.textContent = messages.returnSubtitle;
  cvHead.append(cvTitle, cvSub);

  const feed = doc.createElement("div");
  feed.className = "settings-delegation__feed";
  const timers = new Set<number>();

  const feedNodesByLane = new Map<number, FeedNodes>();
  const actionCleanupTargets: Array<{ btn: HTMLButtonElement; handler: () => void }> = [];

  for (const laneIndex of FEED_ORDER) {
    const res = doc.createElement("div");
    res.className = "settings-delegation__res";
    res.dataset.lane = String(laneIndex);

    const resTop = doc.createElement("div");
    resTop.className = "settings-delegation__res-top";
    const resTitle = doc.createElement("span");
    resTitle.className = "settings-delegation__res-title";

    const indicator = doc.createElement("span");
    indicator.className = "settings-delegation__res-indicator";
    indicator.setAttribute("aria-hidden", "true");
    const pendingDot = doc.createElement("span");
    pendingDot.className = "settings-delegation__res-pending-dot";
    const chk = createSvgElement(doc, "svg", {
      class: "settings-delegation__res-chk",
      viewBox: "0 0 14 14",
    });
    chk.append(createSvgElement(doc, "path", { d: "m3 7.3 2.6 2.6L11 4.4" }));
    indicator.append(pendingDot, chk);

    const titleText = doc.createElement("span");
    titleText.textContent = messages.laneTasks[laneIndex] ?? "";
    resTitle.append(indicator, titleText);

    const meta = doc.createElement("span");
    meta.className = "settings-delegation__res-meta";
    meta.textContent = messages.feedPending;
    resTop.append(resTitle, meta);

    const resBottom = doc.createElement("div");
    resBottom.className = "settings-delegation__res-bottom";
    const resAgent = doc.createElement("span");
    resAgent.className = "settings-delegation__res-agent";
    const actions = doc.createElement("span");
    actions.className = "settings-delegation__res-actions";

    const makeAction = (
      kind: "read" | "ask",
      label: string,
      doneLabel: string,
    ): HTMLButtonElement => {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "settings-delegation__act";
      btn.dataset.act = kind;
      btn.textContent = label;
      let btnTimer: number | null = null;
      const handler = (): void => {
        setHoverLane(laneIndex);
        btn.textContent = doneLabel;
        if (btnTimer !== null) {
          ownerWindow?.clearTimeout(btnTimer);
          timers.delete(btnTimer);
        }
        if (ownerWindow?.setTimeout) {
          btnTimer = ownerWindow.setTimeout(() => {
            if (btnTimer !== null) timers.delete(btnTimer);
            btnTimer = null;
            if (disposed) return;
            btn.textContent = label;
            clearHoverLane();
          }, 1_100);
          timers.add(btnTimer);
        }
      };
      btn.addEventListener("click", handler);
      actionCleanupTargets.push({ btn, handler });
      return btn;
    };

    actions.append(
      makeAction("read", messages.actionRead, messages.actionReadDone),
      makeAction("ask", messages.actionFollowUp, messages.actionFollowUpDone),
    );
    resBottom.append(resAgent, actions);
    res.append(resTop, resBottom);
    feed.append(res);

    feedNodesByLane.set(laneIndex, {
      root: res,
      meta,
      agent: resAgent,
      duration: messages.laneDurations[laneIndex] ?? "",
      laneIndex,
    });
  }

  returnPanel.append(cvHead, feed);
  returnWrap.append(cvDot, returnPanel);
  returnCol.append(returnEyebrow, returnWrap);
  diagram.append(originCol, lanesCol, returnCol);

  // Dynamic SVG Wires
  const createWire = (wireId: string, laneIndex: number): WireNodes => {
    const gradId = `codexhost-dlg-grad-${uid}-${wireId}`;
    const grad = createSvgElement(doc, "linearGradient", {
      id: gradId,
      gradientUnits: "userSpaceOnUse",
    });
    const stop0 = createSvgElement(doc, "stop", { offset: "0%" });
    stop0.style.stopColor = "var(--dlg-accent)";
    stop0.style.stopOpacity = "0";
    const stop1 = createSvgElement(doc, "stop", { offset: "100%" });
    stop1.style.stopColor = "var(--dlg-accent)";
    stop1.style.stopOpacity = "1";
    grad.append(stop0, stop1);
    defs.append(grad);

    const grp = createSvgElement(doc, "g", { "data-lane": String(laneIndex) });
    const base = createSvgElement(doc, "path", { class: "dlg-wire-base" });
    const comet = createSvgElement(doc, "path", {
      class: "dlg-wire-comet",
      stroke: `url(#${gradId})`,
    });
    const halo = createSvgElement(doc, "circle", { class: "dlg-wire-halo", r: "8" });
    const head = createSvgElement(doc, "circle", { class: "dlg-wire-head", r: "2.7" });
    grp.append(base, comet, halo, head);
    svg.append(grp);
    return { grad, grp, base, comet, halo, head, length: 0 };
  };

  const outWires = LANE_SCHEDULES.map((_, i) => createWire(`out-${i}`, i));
  const retWires = LANE_SCHEDULES.map((_, i) => createWire(`ret-${i}`, i));

  // Hover end-to-end highlight
  const allLaneElements = (): Element[] => [
    ...laneNodes.map((n) => n.root),
    ...[...feedNodesByLane.values()].map((n) => n.root),
    ...outWires.map((w) => w.grp),
    ...retWires.map((w) => w.grp),
  ];

  const setHoverLane = (laneIndex: number): void => {
    toggleClass(diagram, "has-hover", true);
    const key = String(laneIndex);
    for (const el of allLaneElements()) {
      toggleClass(el, "is-hover", el.getAttribute("data-lane") === key);
    }
  };

  const clearHoverLane = (): void => {
    toggleClass(diagram, "has-hover", false);
    for (const el of allLaneElements()) {
      toggleClass(el, "is-hover", false);
    }
  };

  const hoverCleanups: Array<() => void> = [];
  for (let index = 0; index < laneNodes.length; index++) {
    const laneEl = laneNodes[index]?.root;
    const feedEl = feedNodesByLane.get(index)?.root;
    for (const target of [laneEl, feedEl]) {
      if (!target) continue;
      const onEnter = (): void => setHoverLane(index);
      const onLeave = (): void => clearHoverLane();
      target.addEventListener("mouseenter", onEnter);
      target.addEventListener("mouseleave", onLeave);
      hoverCleanups.push(() => {
        target.removeEventListener("mouseenter", onEnter);
        target.removeEventListener("mouseleave", onLeave);
      });
    }
  }

  let disposed = false;

  const layoutWires = (): void => {
    if (disposed || typeof diagram.getBoundingClientRect !== "function") return;
    const frameRect = diagram.getBoundingClientRect();
    if (!frameRect.width || !frameRect.height) return;
    svg.setAttribute("viewBox", `0 0 ${frameRect.width} ${frameRect.height}`);

    const relativeBox = (el: Element) => {
      const rect = el.getBoundingClientRect();
      return {
        x: rect.left - frameRect.left + rect.width / 2,
        y: rect.top - frameRect.top + rect.height / 2,
        l: rect.left - frameRect.left,
        r: rect.right - frameRect.left,
        t: rect.top - frameRect.top,
        b: rect.bottom - frameRect.top,
      };
    };

    const vertical = ownerWindow?.getComputedStyle?.(diagram)?.flexDirection === "column";
    const curve = (a: { x: number; y: number }, b: { x: number; y: number }): string => {
      if (!vertical) {
        const dx = (b.x - a.x) * 0.54;
        return `M${a.x} ${a.y} C${a.x + dx} ${a.y} ${b.x - dx} ${b.y} ${b.x} ${b.y}`;
      }
      const dy = (b.y - a.y) * 0.54;
      return `M${a.x} ${a.y} C${a.x} ${a.y + dy} ${b.x} ${b.y - dy} ${b.x} ${b.y}`;
    };

    const orig = relativeBox(originDot);
    const cv = relativeBox(cvDot);
    const startPt = vertical ? { x: orig.x, y: orig.b } : { x: orig.r, y: orig.y };
    const endPt = vertical ? { x: cv.x, y: cv.t } : { x: cv.l, y: cv.y };

    for (let index = 0; index < LANE_SCHEDULES.length; index++) {
      const lane = laneNodes[index];
      const outWire = outWires[index];
      const retWire = retWires[index];
      if (!lane || !outWire || !retWire) continue;
      const inPt = relativeBox(lane.inDot);
      const outPt = relativeBox(lane.outDot);
      const aIn = vertical ? { x: inPt.x, y: inPt.t } : { x: inPt.l, y: inPt.y };
      const aOut = vertical ? { x: outPt.x, y: outPt.b } : { x: outPt.r, y: outPt.y };

      const pairs: readonly [WireNodes, string][] = [
        [outWire, curve(startPt, aIn)],
        [retWire, curve(aOut, endPt)],
      ];
      for (const [wire, pathData] of pairs) {
        wire.base.setAttribute("d", pathData);
        wire.comet.setAttribute("d", pathData);
        wire.length =
          typeof wire.base.getTotalLength === "function" ? wire.base.getTotalLength() : 0;
      }
    }
  };

  const renderComet = (wire: WireNodes, progress: number): void => {
    if (!wire.length || progress <= 0 || progress >= 1) {
      wire.comet.style.opacity = "0";
      wire.head.style.opacity = "0";
      wire.halo.style.opacity = "0";
      return;
    }
    const headDist = cubicEase(progress) * wire.length;
    const tailLen = Math.min(COMET_TAIL_LENGTH, headDist);
    if (tailLen < 0.8 || typeof wire.base.getPointAtLength !== "function") {
      wire.comet.style.opacity = "0";
      wire.head.style.opacity = "0";
      wire.halo.style.opacity = "0";
      return;
    }
    const tailPt = wire.base.getPointAtLength(headDist - tailLen);
    const headPt = wire.base.getPointAtLength(headDist);
    wire.comet.style.strokeDasharray = `${tailLen} ${wire.length + COMET_TAIL_LENGTH}`;
    wire.comet.style.strokeDashoffset = String(-(headDist - tailLen));
    wire.grad.setAttribute("x1", String(tailPt.x));
    wire.grad.setAttribute("y1", String(tailPt.y));
    wire.grad.setAttribute("x2", String(headPt.x));
    wire.grad.setAttribute("y2", String(headPt.y));

    const fadeIn = progress < 0.08 ? progress / 0.08 : 1;
    const fadeOut = progress > 0.9 ? (1 - progress) / 0.1 : 1;
    const alpha = Math.min(fadeIn, fadeOut);
    wire.comet.style.opacity = alpha.toFixed(3);
    wire.head.style.opacity = alpha.toFixed(3);
    wire.halo.style.opacity = (0.17 * alpha).toFixed(3);
    wire.head.setAttribute("cx", String(headPt.x));
    wire.head.setAttribute("cy", String(headPt.y));
    wire.halo.setAttribute("cx", String(headPt.x));
    wire.halo.setAttribute("cy", String(headPt.y));
  };

  const renderFrame = (seconds: number): void => {
    const live = seconds < RESET_AT_SECONDS;
    let dispatching = false;
    let anyReturned = false;

    for (let index = 0; index < LANE_SCHEDULES.length; index++) {
      const schedule = LANE_SCHEDULES[index];
      const lane = laneNodes[index];
      const outWire = outWires[index];
      const retWire = retWires[index];
      const feedNode = feedNodesByLane.get(index);
      if (!schedule || !lane || !outWire || !retWire || !feedNode) continue;

      renderComet(outWire, (seconds - schedule.d) / TRAVEL_SECONDS);
      renderComet(retWire, (seconds - schedule.fin) / TRAVEL_SECONDS);

      if (seconds >= schedule.d && seconds < schedule.d + 0.35) dispatching = true;

      toggleClass(outWire.base, "is-lit", live && seconds >= schedule.arr);
      toggleClass(retWire.base, "is-lit", live && seconds >= schedule.back);

      let status: "idle" | "run" | "done" = "idle";
      let progress = 0;
      let statusText = messages.stateWaiting;

      if (live && seconds >= schedule.d && seconds < schedule.arr) {
        statusText = messages.stateDispatching;
      } else if (live && seconds >= schedule.arr) {
        if (seconds < schedule.fin) {
          status = "run";
          progress = (seconds - schedule.arr) / schedule.run;
          statusText = messages.stateRunning;
        } else {
          status = "done";
          progress = 1;
          statusText = seconds >= schedule.back ? messages.stateReturned : messages.stateReturning;
        }
      }

      toggleClass(lane.root, "is-idle", status === "idle");
      toggleClass(lane.root, "is-run", status === "run");
      toggleClass(lane.root, "is-done", status === "done");
      toggleClass(lane.inDot, "is-lit", live && seconds >= schedule.arr);
      toggleClass(lane.outDot, "is-lit", live && seconds >= schedule.fin);
      lane.prg.style.strokeDashoffset = (RING_CIRCUMFERENCE * (1 - progress)).toFixed(2);
      if (lane.state.textContent !== statusText) lane.state.textContent = statusText;

      const returned = live && seconds >= schedule.back;
      const inFlight = live && seconds >= schedule.arr && !returned;
      if (returned) anyReturned = true;

      toggleClass(feedNode.root, "is-returned", returned);
      toggleClass(feedNode.root, "is-running", inFlight);
      const nextMeta = returned
        ? feedNode.duration
        : inFlight
          ? messages.feedRunning
          : messages.feedPending;
      if (feedNode.meta.textContent !== nextMeta) feedNode.meta.textContent = nextMeta;

      const pulseEl = cvPulses[index];
      if (pulseEl) {
        if (seconds >= schedule.back && seconds < schedule.back + 0.85) {
          const pu = (seconds - schedule.back) / 0.85;
          pulseEl.style.opacity = ((1 - pu) * 0.62).toFixed(3);
          pulseEl.style.transform = `scale(${(1 + pu * 2.5).toFixed(2)})`;
        } else {
          pulseEl.style.opacity = "0";
        }
      }
    }

    toggleClass(originDot, "is-pulse", dispatching);
    toggleClass(cvDot, "is-lit", anyReturned);
  };

  const updateAgents = (readyAgents: readonly DelegationDiagramAgent[]): void => {
    const selected = selectDiagramLanes(readyAgents, messages.laneDefaultModel);
    for (let index = 0; index < laneNodes.length; index++) {
      const agent = selected[index];
      const lane = laneNodes[index];
      const feedNode = feedNodesByLane.get(index);
      if (!agent || !lane || !feedNode) continue;

      lane.root.dataset.harnessId = agent.id;
      lane.dot.style.background = delegationAgentDotColor(agent.id);
      lane.name.textContent = agent.name;
      lane.model.textContent = agent.modelText;
      lane.model.title = agent.modelText;
      toggleClass(lane.model, "is-overridden", agent.overridden);
      feedNode.agent.textContent = agent.name;

      const iconSig = `${agent.id}:${agent.plugin ? "1" : "0"}:${agent.plugin?.icon ?? ""}:${agent.plugin?.iconStyle ? JSON.stringify(agent.plugin.iconStyle) : ""}`;
      if (lane.agentSignature !== iconSig) {
        lane.agentSignature = iconSig;
        const iconEl =
          agent.id === "codex" || agent.plugin
            ? createRendererAgentIcon(agent.id, 16, doc, agent.plugin)
            : createFallbackMark(doc, agent.id);
        lane.mark.replaceChildren(iconEl);
      }
    }
    layoutWires();
  };

  updateAgents(initialAgents);

  let resizeObserver: ResizeObserver | null = null;
  if (typeof ownerWindow?.ResizeObserver === "function") {
    resizeObserver = new ownerWindow.ResizeObserver(layoutWires);
    resizeObserver.observe(diagram);
  }
  layoutWires();
  if (doc.fonts?.ready && typeof doc.fonts.ready.then === "function") {
    void doc.fonts.ready.then(() => {
      if (!disposed) layoutWires();
    });
  }

  const reduceMotionQuery =
    typeof ownerWindow?.matchMedia === "function"
      ? ownerWindow.matchMedia("(prefers-reduced-motion: reduce)")
      : null;

  let elapsed = 0;
  let lastTimestamp = 0;
  let rafId: number | null = null;

  const stopLoop = (): void => {
    if (rafId !== null) {
      ownerWindow?.cancelAnimationFrame?.(rafId);
      rafId = null;
    }
  };

  const tick = (timestamp: number): void => {
    if (disposed) return;
    elapsed += lastTimestamp ? Math.min(0.1, (timestamp - lastTimestamp) / 1000) : 0;
    lastTimestamp = timestamp;
    if (elapsed >= CYCLE_SECONDS) elapsed = 0;
    renderFrame(elapsed);
    if (ownerWindow?.requestAnimationFrame) {
      rafId = ownerWindow.requestAnimationFrame(tick);
    }
  };

  const startLoop = (): void => {
    if (disposed) return;
    stopLoop();
    lastTimestamp = 0;
    if (reduceMotionQuery?.matches || !ownerWindow?.requestAnimationFrame) {
      renderFrame(REDUCED_MOTION_SNAPSHOT_SECONDS);
    } else {
      renderFrame(elapsed);
      rafId = ownerWindow.requestAnimationFrame(tick);
    }
  };

  const onMotionChange = (): void => startLoop();
  reduceMotionQuery?.addEventListener?.("change", onMotionChange);
  startLoop();

  return {
    element: hero,
    updateAgents,
    dispose() {
      if (disposed) return;
      disposed = true;
      stopLoop();
      resizeObserver?.disconnect();
      resizeObserver = null;
      reduceMotionQuery?.removeEventListener?.("change", onMotionChange);
      for (const timerId of timers) ownerWindow?.clearTimeout?.(timerId);
      timers.clear();
      for (const cleanup of hoverCleanups) cleanup();
      for (const { btn, handler } of actionCleanupTargets) {
        btn.removeEventListener("click", handler);
      }
    },
  };
}

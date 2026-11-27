/** Draggable porcelain-pill connection topology with Magic UI-style light beam curves. */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  resolveRemotePeerColor,
  type RemotePeerColor,
  type RemotePeerSummary,
} from "@codexhost/shared-contracts";
import type { RemotePeersTranslate as Translate } from "./RemotePeerPairing.tsx";
import css from "./RemotePeersPanel.module.css";

const MAX_SHOWN_PEERS = 8;
const POSITIONS_STORAGE_KEY = "codexhost.remotePeers.topologyPositions.v1";
const DRAG_THRESHOLD_PX = 3;
const CAPSULE_PAD = 6;
const CHEVRON_LEN = 5.4;
const CHEVRON_SPREAD = 2.8;

export type TopologyNodeId = "local" | string;

export function topologyEdgeKey(from: TopologyNodeId, to: TopologyNodeId): string {
  return `${from}->${to}`;
}

interface RatioPos {
  rx: number;
  ry: number;
}

type StoredPositions = Record<string, RatioPos>;

interface NodeBox {
  cx: number;
  cy: number;
  hx: number;
  hy: number;
}

interface NodeSpec {
  id: TopologyNodeId;
  label: string;
  isLocal: boolean;
  color?: RemotePeerColor;
  connected: boolean;
}

interface DirectedEdge {
  key: string;
  from: TopologyNodeId;
  to: TopologyNodeId;
  offline: boolean;
}

interface BeamEdge {
  pairKey: string;
  from: TopologyNodeId;
  to: TopologyNodeId;
  mutual: boolean;
  offline: boolean;
  forwardKey: string;
  reverseKey: string;
  pathD: string;
  endChevron: string;
  startChevron?: string;
}

function readStoredPositions(): StoredPositions {
  try {
    const raw = window.localStorage.getItem(POSITIONS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const safe: StoredPositions = {};
    for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const rx = (entry as { rx?: unknown }).rx;
      const ry = (entry as { ry?: unknown }).ry;
      if (
        typeof rx === "number" &&
        typeof ry === "number" &&
        Number.isFinite(rx) &&
        Number.isFinite(ry) &&
        rx >= 0 &&
        rx <= 1 &&
        ry >= 0 &&
        ry <= 1
      ) {
        safe[id] = { rx, ry };
      }
    }
    return safe;
  } catch {
    return {};
  }
}

function writeStoredPositions(positions: StoredPositions): void {
  try {
    if (Object.keys(positions).length === 0) {
      window.localStorage.removeItem(POSITIONS_STORAGE_KEY);
    } else {
      window.localStorage.setItem(POSITIONS_STORAGE_KEY, JSON.stringify(positions));
    }
  } catch {
    // Ignore storage quota / private mode failures.
  }
}

function stageHeightFor(totalNodes: number, compact: boolean): number {
  if (totalNodes <= 2) return compact ? 116 : 128;
  if (totalNodes === 3) return compact ? 170 : 182;
  if (totalNodes === 4) return compact ? 198 : 212;
  if (totalNodes <= 6) return compact ? 224 : 238;
  return compact ? 248 : 262;
}

function defaultRatioPosition(index: number, total: number): RatioPos {
  if (total <= 2) {
    return index === 0 ? { rx: 0.24, ry: 0.5 } : { rx: 0.76, ry: 0.5 };
  }
  if (total === 3) {
    const coords: RatioPos[] = [
      { rx: 0.2, ry: 0.5 },
      { rx: 0.76, ry: 0.27 },
      { rx: 0.76, ry: 0.73 },
    ];
    return coords[index] ?? { rx: 0.5, ry: 0.5 };
  }
  if (total === 4) {
    const coords: RatioPos[] = [
      { rx: 0.16, ry: 0.52 },
      { rx: 0.5, ry: 0.2 },
      { rx: 0.83, ry: 0.48 },
      { rx: 0.52, ry: 0.82 },
    ];
    return coords[index] ?? { rx: 0.5, ry: 0.5 };
  }
  if (total === 5) {
    const coords: RatioPos[] = [
      { rx: 0.16, ry: 0.5 },
      { rx: 0.44, ry: 0.18 },
      { rx: 0.82, ry: 0.3 },
      { rx: 0.78, ry: 0.77 },
      { rx: 0.39, ry: 0.82 },
    ];
    return coords[index] ?? { rx: 0.5, ry: 0.5 };
  }
  const angle = Math.PI + (2 * Math.PI * index) / total;
  return {
    rx: 0.5 + 0.35 * Math.cos(angle),
    ry: 0.5 + 0.34 * Math.sin(angle),
  };
}

function clampPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  hx: number,
  hy: number,
): { x: number; y: number } {
  const padX = Math.min(width / 2, Math.max(24, hx + 10));
  const padY = Math.min(height / 2, Math.max(18, hy + 8));
  return {
    x: Math.max(padX, Math.min(width - padX, x)),
    y: Math.max(padY, Math.min(height - padY, y)),
  };
}

function qPoint(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const m = 1 - t;
  return {
    x: m * m * p0.x + 2 * m * t * p1.x + t * t * p2.x,
    y: m * m * p0.y + 2 * m * t * p1.y + t * t * p2.y,
  };
}

function qTangent(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const dx = 2 * (1 - t) * (p1.x - p0.x) + 2 * t * (p2.x - p1.x);
  const dy = 2 * (1 - t) * (p1.y - p0.y) + 2 * t * (p2.y - p1.y);
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

function qSubcurve(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  t0: number,
  t1: number,
): [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }] {
  const split = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    c: { x: number; y: number },
    t: number,
  ) => {
    const ab = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const bc = { x: b.x + (c.x - b.x) * t, y: b.y + (c.y - b.y) * t };
    const abc = { x: ab.x + (bc.x - ab.x) * t, y: ab.y + (bc.y - ab.y) * t };
    return {
      left: [a, ab, abc] as const,
      right: [abc, bc, c] as const,
    };
  };
  const right = split(p0, p1, p2, t0).right;
  const u = (t1 - t0) / Math.max(1e-5, 1 - t0);
  const left = split(right[0], right[1], right[2], u).left;
  return [left[0], left[1], left[2]];
}

/** Exact signed distance to a horizontal stadium/pill centered at `(box.cx, box.cy)`. */
function insideStadium(pt: { x: number; y: number }, box: NodeBox, pad: number): boolean {
  const r = box.hy;
  const straight = Math.max(0, box.hx - r);
  const dx = Math.max(0, Math.abs(pt.x - box.cx) - straight);
  const dy = pt.y - box.cy;
  return Math.hypot(dx, dy) <= r + pad;
}

function trimCurveToPills(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  boxA: NodeBox,
  boxB: NodeBox,
): [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }] | null {
  let lo = 0;
  let hi = 0.49;
  for (let i = 0; i < 14; i += 1) {
    const mid = (lo + hi) / 2;
    if (insideStadium(qPoint(p0, p1, p2, mid), boxA, CAPSULE_PAD)) lo = mid;
    else hi = mid;
  }
  const t0 = hi;

  lo = 0.51;
  hi = 1;
  for (let i = 0; i < 14; i += 1) {
    const mid = (lo + hi) / 2;
    if (insideStadium(qPoint(p0, p1, p2, mid), boxB, CAPSULE_PAD)) hi = mid;
    else lo = mid;
  }
  const t1 = lo;

  if (t1 <= t0 + 0.04) return null;
  const sub = qSubcurve(p0, p1, p2, t0, t1);
  if (Math.hypot(sub[2].x - sub[0].x, sub[2].y - sub[0].y) < 12) return null;
  return sub;
}

function chevronPath(tipX: number, tipY: number, dirX: number, dirY: number): string {
  const nx = -dirY;
  const ny = dirX;
  const bx = tipX - dirX * CHEVRON_LEN;
  const by = tipY - dirY * CHEVRON_LEN;
  return `M ${(bx + nx * CHEVRON_SPREAD).toFixed(2)} ${(by + ny * CHEVRON_SPREAD).toFixed(2)} L ${tipX.toFixed(2)} ${tipY.toFixed(2)} L ${(bx - nx * CHEVRON_SPREAD).toFixed(2)} ${(by - ny * CHEVRON_SPREAD).toFixed(2)}`;
}

function LocalDeviceIcon(): ReactNode {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.45"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="2.5" width="12" height="8" rx="1.6" />
      <path d="M5.2 13.5h5.6M8 10.5v3" />
    </svg>
  );
}

export function RemotePeersTopology({
  peers,
  recentEdgeKeys,
  t,
}: {
  peers: readonly RemotePeerSummary[];
  recentEdgeKeys?: ReadonlySet<string>;
  t: Translate;
}): ReactNode {
  const glowFilterId = useId();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef<Map<TopologyNodeId, HTMLDivElement>>(new Map());

  const [hoveredId, setHoveredId] = useState<TopologyNodeId | null>(null);
  const [pinnedId, setPinnedId] = useState<TopologyNodeId | null>(null);
  const [draggingId, setDraggingId] = useState<TopologyNodeId | null>(null);
  const [stageWidth, setStageWidth] = useState(520);
  const [customPositions, setCustomPositions] = useState<StoredPositions>(() =>
    typeof window === "undefined" ? {} : readStoredPositions(),
  );
  const [measuredSizes, setMeasuredSizes] = useState<Record<string, { hx: number; hy: number }>>(
    {},
  );

  const customPositionsRef = useRef(customPositions);
  customPositionsRef.current = customPositions;

  const enabledPeers = useMemo(() => peers.filter((peer) => peer.enabled), [peers]);
  const shownPeers = useMemo(() => enabledPeers.slice(0, MAX_SHOWN_PEERS), [enabledPeers]);
  const overflowCount = enabledPeers.length - shownPeers.length;
  const localLabel = t("remotePeers.pairing.localHost");

  const nodeSpecs = useMemo<NodeSpec[]>(
    () => [
      {
        id: "local",
        label: localLabel,
        isLocal: true,
        connected: true,
      },
      ...shownPeers.map((peer) => ({
        id: peer.peerId,
        label: peer.name,
        isLocal: false,
        color: resolveRemotePeerColor(peer.hostId, peer.color),
        connected: peer.state === "connected",
      })),
    ],
    [localLabel, shownPeers],
  );

  const compact = stageWidth < 430;
  const stageHeight = stageHeightFor(nodeSpecs.length, compact);

  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const syncWidth = () => {
      const next = Math.round(el.getBoundingClientRect().width);
      if (next > 0) setStageWidth(next);
    };
    syncWidth();
    const observer = new ResizeObserver(syncWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, [enabledPeers.length]);

  const measureNodes = useCallback(() => {
    const next: Record<string, { hx: number; hy: number }> = {};
    let changed = false;
    for (const spec of nodeSpecs) {
      const el = nodeRefs.current.get(spec.id);
      if (!el) continue;
      const hx = el.offsetWidth / 2;
      const hy = el.offsetHeight / 2;
      if (hx <= 0 || hy <= 0) continue;
      next[spec.id] = { hx, hy };
    }
    setMeasuredSizes((prev) => {
      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(next);
      if (prevKeys.length !== nextKeys.length) changed = true;
      else {
        for (const key of nextKeys) {
          const a = prev[key];
          const b = next[key];
          if (!a || !b || Math.abs(a.hx - b.hx) > 0.5 || Math.abs(a.hy - b.hy) > 0.5) {
            changed = true;
            break;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [nodeSpecs]);

  useLayoutEffect(() => {
    measureNodes();
  }, [measureNodes, stageWidth]);

  const nodeBoxes = useMemo(() => {
    const map = new Map<TopologyNodeId, NodeBox>();
    const total = nodeSpecs.length;
    for (let i = 0; i < total; i += 1) {
      const spec = nodeSpecs[i]!;
      const measured = measuredSizes[spec.id];
      const hx = measured?.hx ?? (spec.isLocal ? 40 : 54);
      const hy = measured?.hy ?? 16;
      const ratio = customPositions[spec.id] ?? defaultRatioPosition(i, total);
      const clamped = clampPosition(
        ratio.rx * stageWidth,
        ratio.ry * stageHeight,
        stageWidth,
        stageHeight,
        hx,
        hy,
      );
      map.set(spec.id, { cx: clamped.x, cy: clamped.y, hx, hy });
    }
    return map;
  }, [customPositions, measuredSizes, nodeSpecs, stageHeight, stageWidth]);

  const nodeSpecById = useMemo(
    () => new Map<TopologyNodeId, NodeSpec>(nodeSpecs.map((spec) => [spec.id, spec])),
    [nodeSpecs],
  );

  const directedEdges = useMemo<DirectedEdge[]>(() => {
    const shownIds = new Set(shownPeers.map((peer) => peer.peerId));
    const edges: DirectedEdge[] = [];
    for (const peer of shownPeers) {
      const connected = peer.state === "connected";
      edges.push({
        key: topologyEdgeKey("local", peer.peerId),
        from: "local",
        to: peer.peerId,
        offline: !connected,
      });
      if (connected && peer.pairedBack === true) {
        edges.push({
          key: topologyEdgeKey(peer.peerId, "local"),
          from: peer.peerId,
          to: "local",
          offline: false,
        });
      }
      if (connected && peer.linkedPeerIds !== undefined) {
        for (const targetPeerId of peer.linkedPeerIds) {
          if (targetPeerId === peer.peerId || !shownIds.has(targetPeerId)) continue;
          edges.push({
            key: topologyEdgeKey(peer.peerId, targetPeerId),
            from: peer.peerId,
            to: targetPeerId,
            offline: false,
          });
        }
      }
    }
    return edges;
  }, [shownPeers]);

  const beamEdges = useMemo<BeamEdge[]>(() => {
    const edgeByKey = new Map(directedEdges.map((edge) => [edge.key, edge]));
    const visited = new Set<string>();
    const result: BeamEdge[] = [];
    const centerX = stageWidth / 2;
    const centerY = stageHeight / 2;

    for (const edge of directedEdges) {
      const pairKey = edge.from < edge.to ? `${edge.from}|${edge.to}` : `${edge.to}|${edge.from}`;
      if (visited.has(pairKey)) continue;
      visited.add(pairKey);

      const reverse = edgeByKey.get(topologyEdgeKey(edge.to, edge.from));
      const boxFrom = nodeBoxes.get(edge.from);
      const boxTo = nodeBoxes.get(edge.to);
      if (!boxFrom || !boxTo) continue;

      const p0 = { x: boxFrom.cx, y: boxFrom.cy };
      const p2 = { x: boxTo.cx, y: boxTo.cy };
      const dx = p2.x - p0.x;
      const dy = p2.y - p0.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1) continue;

      const nx = -dy / dist;
      const ny = dx / dist;
      const midX = (p0.x + p2.x) / 2;
      const midY = (p0.y + p2.y) / 2;
      const outDot = (midX - centerX) * nx + (midY - centerY) * ny;
      const bowSign = outDot >= 0 ? 1 : -1;
      const bowMag = Math.min(22, Math.max(9, dist * 0.085));
      const ctrl = {
        x: midX + nx * bowSign * bowMag,
        y: midY + ny * bowSign * bowMag,
      };

      const trimmed = trimCurveToPills(p0, ctrl, p2, boxFrom, boxTo);
      if (!trimmed) continue;

      const [s0, s1, s2] = trimmed;
      const pathD = `M ${s0.x.toFixed(1)} ${s0.y.toFixed(1)} Q ${s1.x.toFixed(1)} ${s1.y.toFixed(1)} ${s2.x.toFixed(1)} ${s2.y.toFixed(1)}`;
      const tanStart = qTangent(s0, s1, s2, 0);
      const tanEnd = qTangent(s0, s1, s2, 1);
      const mutual = reverse !== undefined;
      const offline = edge.offline && (reverse === undefined || reverse.offline);

      result.push({
        pairKey,
        from: edge.from,
        to: edge.to,
        mutual,
        offline,
        forwardKey: edge.key,
        reverseKey: topologyEdgeKey(edge.to, edge.from),
        pathD,
        endChevron: chevronPath(s2.x, s2.y, tanEnd.x, tanEnd.y),
        ...(mutual ? { startChevron: chevronPath(s0.x, s0.y, -tanStart.x, -tanStart.y) } : {}),
      });
    }
    return result;
  }, [directedEdges, nodeBoxes, stageHeight, stageWidth]);

  const hasCustomLayout = useMemo(
    () => nodeSpecs.some((spec) => customPositions[spec.id] !== undefined),
    [customPositions, nodeSpecs],
  );

  const activeNodeId =
    draggingId !== null && nodeSpecById.has(draggingId)
      ? draggingId
      : hoveredId !== null && nodeSpecById.has(hoveredId)
        ? hoveredId
        : pinnedId !== null && nodeSpecById.has(pinnedId)
          ? pinnedId
          : null;

  const connectedToActive = useMemo(() => {
    if (activeNodeId === null) return null;
    const set = new Set<TopologyNodeId>([activeNodeId]);
    for (const edge of directedEdges) {
      if (edge.from === activeNodeId) set.add(edge.to);
      if (edge.to === activeNodeId) set.add(edge.from);
    }
    return set;
  }, [activeNodeId, directedEdges]);

  const activeSummary = useMemo(() => {
    if (activeNodeId === null) return null;
    const node = nodeSpecById.get(activeNodeId);
    if (!node) return null;

    if (!node.connected) {
      return t("remotePeers.topology.summary.offline", { name: node.label });
    }

    const outSet = new Set<TopologyNodeId>();
    const inSet = new Set<TopologyNodeId>();
    for (const edge of directedEdges) {
      if (edge.offline) continue;
      if (edge.from === activeNodeId) outSet.add(edge.to);
      if (edge.to === activeNodeId) inSet.add(edge.from);
    }

    const mutualNames: string[] = [];
    for (const other of nodeSpecs) {
      if (other.id === activeNodeId) continue;
      if (outSet.has(other.id) && inSet.has(other.id)) {
        mutualNames.push(other.label);
      }
    }

    if (mutualNames.length > 0) {
      return t("remotePeers.topology.summary.mutual", {
        name: node.label,
        peers: mutualNames.join(t("remotePeers.topology.listSeparator")),
      });
    }

    if (node.isLocal) {
      return t("remotePeers.topology.summary.localOneWay", { name: node.label });
    }

    return t("remotePeers.topology.summary.oneWay", { name: node.label });
  }, [activeNodeId, directedEdges, nodeSpecById, nodeSpecs, t]);

  const handleResetLayout = useCallback(() => {
    setCustomPositions({});
    writeStoredPositions({});
  }, []);

  const handlePointerDown = useCallback(
    (nodeId: TopologyNodeId, event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      const target = event.currentTarget;
      const startBox = nodeBoxes.get(nodeId);
      if (!startBox) return;

      event.preventDefault();
      target.setPointerCapture(event.pointerId);
      const startClientX = event.clientX;
      const startClientY = event.clientY;
      let moved = false;

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startClientX;
        const dy = ev.clientY - startClientY;
        if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
          moved = true;
          setDraggingId(nodeId);
        }
        if (!moved) return;
        const rect = stageRef.current?.getBoundingClientRect();
        const width = rect && rect.width > 0 ? rect.width : stageWidth;
        const height = rect && rect.height > 0 ? rect.height : stageHeight;
        const clamped = clampPosition(
          startBox.cx + dx,
          startBox.cy + dy,
          width,
          height,
          startBox.hx,
          startBox.hy,
        );
        const nextRatio: RatioPos = {
          rx: clamped.x / width,
          ry: clamped.y / height,
        };
        setCustomPositions((prev) => ({ ...prev, [nodeId]: nextRatio }));
      };

      const finish = (ev: PointerEvent) => {
        if (target.hasPointerCapture(ev.pointerId)) {
          target.releasePointerCapture(ev.pointerId);
        }
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", finish);
        target.removeEventListener("pointercancel", finish);
        if (moved) {
          setDraggingId(null);
          writeStoredPositions(customPositionsRef.current);
        } else {
          setPinnedId((current) => (current === nodeId ? null : nodeId));
        }
      };

      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", finish);
      target.addEventListener("pointercancel", finish);
    },
    [nodeBoxes, stageHeight, stageWidth],
  );

  if (enabledPeers.length === 0) return null;

  return (
    <section
      className={css.topologyCard}
      aria-label={t("remotePeers.topology.title")}
      data-remote-peers-topology
    >
      <div className={css.topologyHeader}>
        <div className={css.topologyTitleRow}>
          <h3 className={css.topologyTitle}>{t("remotePeers.topology.title")}</h3>
          {overflowCount > 0 && (
            <span
              className={css.topologyOverflow}
              title={t("remotePeers.topology.overflowTooltip", { count: overflowCount })}
            >
              {`+${String(overflowCount)}`}
            </span>
          )}
        </div>
        <div className={css.topologyHeaderRight}>
          <div className={css.topologyLegend} aria-hidden="true">
            <span className={css.topologyLegendItem}>
              <span className={css.topologyLegendGlyph}>⇄</span>
              <span>{t("remotePeers.topology.legendMutual")}</span>
            </span>
            <span className={css.topologyLegendItem}>
              <span className={css.topologyLegendGlyphMuted}>→</span>
              <span>{t("remotePeers.topology.legendOneWay")}</span>
            </span>
          </div>
          {hasCustomLayout && (
            <button type="button" className={css.topologyResetButton} onClick={handleResetLayout}>
              {t("remotePeers.topology.resetLayout")}
            </button>
          )}
        </div>
      </div>

      <div
        ref={stageRef}
        className={css.topologyStage}
        style={{ height: `${String(stageHeight)}px` }}
        data-dragging={draggingId !== null}
        onClick={(event) => {
          if (event.target === event.currentTarget) setPinnedId(null);
        }}
      >
        <svg
          className={css.topologySvg}
          width={stageWidth}
          height={stageHeight}
          viewBox={`0 0 ${String(stageWidth)} ${String(stageHeight)}`}
          aria-hidden="true"
        >
          <defs>
            <filter id={glowFilterId} x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="1.35" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {beamEdges.map((edge, index) => {
            const related =
              activeNodeId === null || edge.from === activeNodeId || edge.to === activeNodeId;
            const highlighted = activeNodeId !== null && related;
            const dimmed = activeNodeId !== null && !related;
            const isRecent =
              recentEdgeKeys?.has(edge.forwardKey) === true ||
              (edge.mutual && recentEdgeKeys?.has(edge.reverseKey) === true);
            const delaySec = `${String(-((index * 0.55) % 2.4))}s`;
            const reverseDelaySec = `${String(-((index * 0.55 + 1.2) % 2.4))}s`;

            return (
              <g
                key={edge.pairKey}
                className={css.topologyBeamGroup}
                data-mutual={edge.mutual}
                data-offline={edge.offline}
                data-highlighted={highlighted}
                data-dimmed={dimmed}
                data-recent={isRecent}
              >
                <path d={edge.pathD} className={css.topologyBeamRail} />

                {!edge.offline && (
                  <>
                    <path
                      d={edge.pathD}
                      className={css.topologyBeamPulse}
                      filter={`url(#${glowFilterId})`}
                      style={{ animationDelay: delaySec }}
                    />
                    {edge.mutual && (
                      <path
                        d={edge.pathD}
                        className={css.topologyBeamPulseReverse}
                        filter={`url(#${glowFilterId})`}
                        style={{ animationDelay: reverseDelaySec }}
                      />
                    )}
                  </>
                )}

                <path d={edge.endChevron} className={css.topologyBeamChevron} />
                {edge.startChevron !== undefined && (
                  <path d={edge.startChevron} className={css.topologyBeamChevron} />
                )}
              </g>
            );
          })}
        </svg>

        <div className={css.topologyNodeLayer}>
          {nodeSpecs.map((spec) => {
            const box = nodeBoxes.get(spec.id);
            if (!box) return null;
            const isActive = activeNodeId === spec.id;
            const isDragging = draggingId === spec.id;
            const isDimmed = connectedToActive !== null && !connectedToActive.has(spec.id);

            return (
              <div
                key={spec.id}
                ref={(el) => {
                  if (el) nodeRefs.current.set(spec.id, el);
                  else nodeRefs.current.delete(spec.id);
                }}
                className={css.topologyPillNode}
                style={{ left: `${box.cx.toFixed(1)}px`, top: `${box.cy.toFixed(1)}px` }}
                data-node-id={spec.id}
                data-local={spec.isLocal}
                data-connected={spec.connected}
                data-active={isActive}
                data-dragging={isDragging}
                data-dimmed={isDimmed}
                role="button"
                tabIndex={0}
                aria-label={spec.label}
                aria-pressed={pinnedId === spec.id}
                title={spec.label}
                onPointerDown={(event) => handlePointerDown(spec.id, event)}
                onPointerEnter={() => {
                  if (draggingId === null) setHoveredId(spec.id);
                }}
                onPointerLeave={() => {
                  if (draggingId === null) {
                    setHoveredId((current) => (current === spec.id ? null : current));
                  }
                }}
                onFocus={() => setHoveredId(spec.id)}
                onBlur={() => setHoveredId((current) => (current === spec.id ? null : current))}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setPinnedId((current) => (current === spec.id ? null : spec.id));
                  } else if (event.key === "Escape") {
                    setPinnedId(null);
                    setHoveredId(null);
                  }
                }}
              >
                {spec.isLocal ? (
                  <span className={css.topologyLocalIcon}>
                    <LocalDeviceIcon />
                  </span>
                ) : (
                  <span
                    className={css.topologyDotRing}
                    data-color={spec.color}
                    data-connected={spec.connected}
                    aria-hidden="true"
                  >
                    <span className={css.topologyDotCore} />
                  </span>
                )}
                <span className={css.topologyPillLabel}>{spec.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className={css.topologyFooter}>
        <span
          className={activeSummary !== null ? css.topologySummary : css.topologyHint}
          role={activeSummary !== null ? "status" : undefined}
        >
          {activeSummary ?? t("remotePeers.topology.hint")}
        </span>
      </div>
    </section>
  );
}

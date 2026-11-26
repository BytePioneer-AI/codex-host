import type * as c from "@codexhost/shared-contracts";
import type { PeerHostClient } from "./peer-host-client.ts";
import { parsePeerUrl } from "./peer-host-store.ts";

export type ResolvePeerSelfShare = (
  preferredOrigin?: string,
) => Promise<{ origin: string; token: string; name: string } | { error: string }>;

const SELF_ORIGIN_KINDS = [
  "public",
  "relay",
  "tailscale-funnel",
  "tailscale-https",
  "lan",
] as const;

export function resolvePeerSelfOrigin(
  urls: readonly c.WebNetworkAccessUrl[],
  preferredOrigin: string | undefined,
  loopbackFallback?: string,
): { origin: string } | { error: string } {
  const origins = SELF_ORIGIN_KINDS.flatMap((kind) =>
    urls.flatMap((entry) => {
      if (entry.kind !== kind) return [];
      try {
        return [parsePeerUrl(entry.url).origin];
      } catch {
        return [];
      }
    }),
  );
  if (origins.length === 0 && loopbackFallback !== undefined) origins.push(loopbackFallback);
  if (preferredOrigin !== undefined) {
    try {
      const origin = parsePeerUrl(preferredOrigin, { allowLoopback: true }).origin;
      if (origins.includes(origin)) return { origin };
    } catch {
      // Reject invalid or unadvertised origins without echoing them.
    }
    return { error: "The requested address is not a shareable address of this Host" };
  }
  const origin = origins[0];
  return origin === undefined
    ? { error: "This Host has no shareable network address" }
    : { origin };
}

const PAIRING_CONCURRENCY = 8;
type PairingJob = { target: PeerHostClient; introduced: PeerHostClient | "local" };

async function inBatches<T>(items: readonly T[], run: (item: T) => Promise<unknown>) {
  for (let i = 0; i < items.length; i += PAIRING_CONCURRENCY) {
    await Promise.all(items.slice(i, i + PAIRING_CONCURRENCY).map(run));
  }
}

function unavailable(target: PeerHostClient): string | undefined {
  if (!target.record.enabled || target.state !== "connected") return "Remote peer is not connected";
  if (target.manifest?.capabilities?.peerPairing !== 1)
    return "Remote peer does not support pairing";
  return undefined;
}

export async function syncPeerMesh(options: {
  targets: PeerHostClient[];
  /** On add, only form links involving the new peer; never re-pair existing peers to each other. */
  anchor?: PeerHostClient | undefined;
  includeSelf: boolean;
  includeMesh: boolean;
  selfOrigin: string | undefined;
  localNodeId: string | undefined;
  resolveSelfShare: ResolvePeerSelfShare | undefined;
  peerTokens: () => string[];
  changed: (target: PeerHostClient) => void;
}): Promise<c.RemotePeerPairingReport> {
  const { targets, anchor } = options;
  const selfTargets = options.includeSelf ? (anchor ? [anchor] : targets) : [];
  const jobs: PairingJob[] = selfTargets.map((target) => ({ target, introduced: "local" }));
  if (options.includeMesh) {
    for (const [i, target] of targets.entries()) {
      const others = anchor ? [anchor] : targets.slice(i + 1);
      for (const other of others) {
        jobs.push({ target, introduced: other }, { target: other, introduced: target });
      }
    }
  }

  const secrets = new Set(options.peerTokens());
  let selfShare: Awaited<ReturnType<ResolvePeerSelfShare>> | undefined;
  if (selfTargets.some((target) => unavailable(target) === undefined)) {
    try {
      selfShare = await options.resolveSelfShare?.(options.selfOrigin);
    } catch {
      selfShare = { error: "Could not resolve this Host's shareable connection" };
    }
  }
  if (selfShare && "token" in selfShare) secrets.add(selfShare.token);

  const results: c.RemotePeerPairingStep[] = [];
  const refreshed = new Set<PeerHostClient>();
  await inBatches(
    jobs.map((job, i) => ({ ...job, i })),
    async ({ target, introduced, i }) => {
      const record = introduced === "local" ? undefined : introduced.record;
      const share = introduced === "local" ? selfShare : record;
      const step = {
        targetPeerId: target.record.peerId,
        targetName: target.record.name,
        introducedHost: record?.peerId ?? "local",
        introducedName: share && "name" in share ? share.name : "Local Host",
      };
      const reason = unavailable(target);
      if (reason !== undefined) {
        results[i] = { ...step, status: "skipped", error: reason };
        return;
      }
      if (!share || "error" in share) {
        results[i] = {
          ...step,
          status: "failed",
          error: share?.error ?? "This Host has no shareable connection",
        };
        return;
      }
      secrets.add(share.token);
      secrets.add(target.record.token);
      const nodeId =
        introduced === "local"
          ? options.localNodeId
          : (introduced.manifest?.nodeId ?? record?.nodeId);
      try {
        const { status } = await target.introduce({
          origin: share.origin,
          token: share.token,
          name: share.name,
          ...(record?.color !== undefined ? { color: record.color } : {}),
          ...(nodeId !== undefined ? { expectedNodeId: nodeId } : {}),
        });
        results[i] = { ...step, status };
        refreshed.add(target);
      } catch (error) {
        results[i] = {
          ...step,
          status: "failed",
          error: error instanceof Error ? error.message : "Peer pairing failed",
        };
      }
    },
  );

  await inBatches([...refreshed], async (target) => {
    await target.probe().catch(() => undefined);
    options.changed(target);
  });

  for (const token of options.peerTokens()) secrets.add(token);
  // Do not echo errors containing credentials, including URL-encoded forms.
  const sensitive = [...secrets]
    .filter(Boolean)
    .flatMap((token) => [token, new URLSearchParams({ token }).toString().slice(6)]);
  for (const result of results) {
    const error = result.error;
    if (error === undefined) continue;
    result.error = sensitive.some((value) => error.includes(value))
      ? "Peer pairing failed (details redacted)"
      : error.slice(0, 1000);
  }
  return { results };
}

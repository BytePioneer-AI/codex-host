/** Two-level `@` / `#` trigger source for cross-host remote delegation. */
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-model-selection/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type {
  InputTriggerCandidate,
  InputTriggerCrumb,
} from "@deepseek-ai/dsh-client-ui-input-trigger/client";
import {
  formatDelegationMentionLink,
  REMOTE_PEERS_CHANGED_EVENT,
  resolveRemotePeerColor,
  type DelegationHostHarnessOption,
  type DelegationRemoteHostOption,
  type RemotePeerColor,
} from "@codexhost/shared-contracts";
import {
  harnessIconSources,
  IconDataOutlineRegular,
  IconGlobeOutlineRegular,
  RemotePluginIcon,
  type IconProps,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { remoteDelegationApi } from "./api.ts";
import { REMOTE_PEERS_UPDATED_EVENT } from "./remote-peers-events.ts";

const REMOTE_HOSTS = "codexhost-remote-hosts";
const ROOT_CRUMB = "__root__";
const HOST_PREFIX = "host:";
const HARNESS_PREFIX = "harness:";

const PEER_ACCENT_COLOR: Readonly<Record<RemotePeerColor, string>> = {
  blue: "#3b82f6",
  purple: "#8b5cf6",
  cyan: "#06b6d4",
  green: "#10b981",
  amber: "#f59e0b",
  rose: "#f43f5e",
  slate: "#64748b",
};

function RemoteHostIcon({ host, size }: { host: DelegationRemoteHostOption; size: number }) {
  const color = host.isLocal
    ? undefined
    : PEER_ACCENT_COLOR[resolveRemotePeerColor(host.hostId, host.color)];
  return (
    <span style={color ? { color, display: "inline-flex" } : { display: "inline-flex" }}>
      <IconGlobeOutlineRegular size={size} />
    </span>
  );
}

export interface RemoteHostDelegationDeps {
  hostIdOf(id: SessionId): string;
  supportsDelegation(id: SessionId): boolean;
  notify(id: SessionId, text: string): void;
}

export function registerRemoteHostDelegation(ctx: Context, deps: RemoteHostDelegationDeps): void {
  const connection = ctx.get("connection") as ConnectionHandle;
  const t = ctx.locale.bind("codexhostImport");
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };

  const hostsInFlight = new Map<string, Promise<DelegationRemoteHostOption[]>>();
  const hostsData = new Map<string, DelegationRemoteHostOption[]>();
  const harnessesInFlight = new Map<string, Promise<DelegationHostHarnessOption[]>>();
  const harnessesData = new Map<string, DelegationHostHarnessOption[]>();
  const drilledHost = new Map<SessionId, DelegationRemoteHostOption>();
  const lastQuery = new Map<SessionId, string>();

  const invalidate = () => {
    hostsInFlight.clear();
    hostsData.clear();
    harnessesInFlight.clear();
    harnessesData.clear();
    changed();
  };

  const displayNameOf = (host: DelegationRemoteHostOption): string =>
    host.isLocal ? t("discovery.localHost") : host.name;

  const loadHosts = (sessionHostId: string): Promise<DelegationRemoteHostOption[]> => {
    const cached = hostsData.get(sessionHostId);
    if (cached !== undefined) return Promise.resolve(cached);
    let request = hostsInFlight.get(sessionHostId);
    if (!request) {
      request = remoteDelegationApi
        .remoteHosts(sessionHostId)
        .then((res) => {
          hostsData.set(sessionHostId, res.hosts);
          hostsInFlight.delete(sessionHostId);
          return res.hosts;
        })
        .catch(() => {
          hostsInFlight.delete(sessionHostId);
          return [];
        });
      hostsInFlight.set(sessionHostId, request);
    }
    return request;
  };

  const loadHarnesses = (
    host: DelegationRemoteHostOption,
  ): Promise<DelegationHostHarnessOption[]> => {
    if (host.isLocal) {
      const localGroups = ctx.modelDirectories.harnessCatalog.getSnapshot().value?.groups;
      if (localGroups && localGroups.length > 0) {
        const list = localGroups.map(({ id, name }) => ({ id, name }));
        harnessesData.set(host.hostId, list);
        return Promise.resolve(list);
      }
    }
    const cached = harnessesData.get(host.hostId);
    if (cached !== undefined) return Promise.resolve(cached);
    let request = harnessesInFlight.get(host.hostId);
    if (!request) {
      request = remoteDelegationApi
        .hostHarnesses(host.hostId)
        .then((res) => {
          harnessesData.set(host.hostId, res.harnesses);
          harnessesInFlight.delete(host.hostId);
          return res.harnesses;
        })
        .catch(() => {
          harnessesInFlight.delete(host.hostId);
          return [];
        });
      harnessesInFlight.set(host.hostId, request);
    }
    return request;
  };

  ctx.effect(
    () => connection.generation.subscribe(invalidate),
    "ui-codexhost: remote host delegation connection generation",
  );
  ctx.effect(
    () => ctx.remote.$on(REMOTE_PEERS_CHANGED_EVENT, invalidate),
    "ui-codexhost: remote host delegation peer changes",
  );
  ctx.effect(() => {
    if (typeof window === "undefined") return () => {};
    window.addEventListener(REMOTE_PEERS_UPDATED_EVENT, invalidate);
    return () => {
      window.removeEventListener(REMOTE_PEERS_UPDATED_EVENT, invalidate);
    };
  }, "ui-codexhost: remote host delegation window peer updates");

  ctx.effect(
    () =>
      ctx.inputTriggers.registerSource({
        trigger: "@",
        aliases: ["#"],
        name: REMOTE_HOSTS,
        launcher: "command",
        launcherOrder: 31,
        order: 15,
        showGroupTitle: false,
        drillExclusive: true,
        codec: { clipboardText: (ref) => ref, serialize: async (ref) => ref },
        subscribeCandidates: (_session, listener) => {
          listeners.add(listener);
          const off = ctx.sessions.list.subscribe(listener);
          return () => {
            listeners.delete(listener);
            off();
          };
        },
        onClose: ({ sessionId }) => {
          drilledHost.delete(sessionId);
          lastQuery.delete(sessionId);
        },
        header: ({ sessionId }): readonly InputTriggerCrumb[] | undefined => {
          const active = drilledHost.get(sessionId);
          if (!active) return undefined;
          return [
            { label: t("discovery.remoteHosts"), value: ROOT_CRUMB },
            { label: displayNameOf(active), value: active.hostId, current: true },
          ];
        },
        candidates: async ({ sessionId }, req) => {
          lastQuery.set(sessionId, req.query);
          if (!deps.supportsDelegation(sessionId)) {
            drilledHost.delete(sessionId);
            return [];
          }
          const query = req.query.toLocaleLowerCase();
          const activeHost = drilledHost.get(sessionId);
          if (activeHost) {
            const harnesses = await loadHarnesses(activeHost);
            req.signal.throwIfAborted();
            if (!deps.supportsDelegation(sessionId) || drilledHost.get(sessionId) !== activeHost) {
              return [];
            }
            const hostName = displayNameOf(activeHost);
            const iconHostId = activeHost.isLocal ? undefined : activeHost.hostId;
            const rows: InputTriggerCandidate[] = [];
            const anyLabel = t("discovery.remoteHostAnyAgent", { host: hostName });
            const anyDesc = t("discovery.remoteHostAnyAgentDesc");
            if (
              query === "" ||
              `${anyLabel} ${anyDesc} ${hostName} default any`.toLocaleLowerCase().includes(query)
            ) {
              rows.push({
                name: "__any__",
                label: anyLabel,
                showAlias: false,
                description: anyDesc,
                value: `${HOST_PREFIX}${activeHost.hostId}`,
                icon: (props: IconProps) => (
                  <RemoteHostIcon host={activeHost} size={props.size ?? 14} />
                ),
              });
            }
            for (const harness of harnesses) {
              if (!`${harness.name} ${harness.id}`.toLocaleLowerCase().includes(query)) continue;
              const icon = harnessIconSources(harness.id, iconHostId);
              rows.push({
                name: harness.id,
                label: harness.name,
                value: `${HARNESS_PREFIX}${activeHost.hostId}:${harness.id}`,
                icon: (props: IconProps) => (
                  <RemotePluginIcon
                    id={harness.id}
                    src={icon.src}
                    presentationUrl={icon.presentationUrl}
                    size={props.size ?? 14}
                    fallback={<IconDataOutlineRegular size={props.size ?? 14} />}
                  />
                ),
              });
            }
            if (harnesses.length === 0 && query === "") {
              rows.push({
                name: "empty",
                label: t("discovery.remoteHostNoAgents"),
                showAlias: false,
                disabledReason: t("discovery.remoteHostNoAgents"),
              });
            }
            return rows;
          }

          const sessionHostId = deps.hostIdOf(sessionId);
          const hosts = await loadHosts(sessionHostId);
          req.signal.throwIfAborted();
          if (!deps.supportsDelegation(sessionId)) return [];
          return hosts
            .filter((host) => {
              const label = displayNameOf(host);
              return `${label} ${host.name} ${host.hostname ?? ""} ${host.hostId}`
                .toLocaleLowerCase()
                .includes(query);
            })
            .map((host): InputTriggerCandidate => {
              const label = displayNameOf(host);
              const desc =
                host.hostname && host.hostname.toLowerCase() !== label.toLowerCase()
                  ? host.hostname
                  : undefined;
              return {
                name: host.hostId,
                label,
                showAlias: false,
                ...(desc === undefined ? {} : { description: desc }),
                value: `${HOST_PREFIX}${host.hostId}`,
                section: t("discovery.remoteHosts"),
                drill: true,
                drillLabel: t("discovery.selectAgent"),
                icon: (props: IconProps) => <RemoteHostIcon host={host} size={props.size ?? 14} />,
              };
            });
        },
        onPick: (pick) => {
          const { sessionId } = pick.session;
          const value = pick.candidate.value ?? "";
          const trigger = pick.trigger === "#" ? "#" : "@";
          const hasTypedQuery =
            pick.span.end - pick.span.start > 1 || (lastQuery.get(sessionId) ?? "").length > 0;

          if (pick.action === "drill") {
            if (value === ROOT_CRUMB) {
              drilledHost.delete(sessionId);
              return hasTypedQuery && pick.span.end - pick.span.start > 1
                ? { text: trigger, continue: true }
                : "refresh";
            }
            if (!value.startsWith(HOST_PREFIX)) return "handled";
            const targetHostId = value.slice(HOST_PREFIX.length);
            const host = hostsData
              .get(deps.hostIdOf(sessionId))
              ?.find((item) => item.hostId === targetHostId);
            if (!deps.supportsDelegation(sessionId) || !host) {
              deps.notify(sessionId, t("discovery.stale"));
              return "handled";
            }
            drilledHost.set(sessionId, host);
            void loadHarnesses(host);
            return hasTypedQuery && pick.span.end - pick.span.start > 1
              ? { text: trigger, continue: true }
              : "refresh";
          }

          if (!deps.supportsDelegation(sessionId)) {
            drilledHost.delete(sessionId);
            deps.notify(sessionId, t("discovery.stale"));
            return "handled";
          }

          if (value.startsWith(HOST_PREFIX)) {
            const targetHostId = value.slice(HOST_PREFIX.length);
            const active = drilledHost.get(sessionId);
            const host =
              active?.hostId === targetHostId
                ? active
                : hostsData
                    .get(deps.hostIdOf(sessionId))
                    ?.find((item) => item.hostId === targetHostId);
            drilledHost.delete(sessionId);
            if (!host) {
              deps.notify(sessionId, t("discovery.stale"));
              return "handled";
            }
            const label = displayNameOf(host);
            const ref = formatDelegationMentionLink({ hostId: host.hostId, label });
            return {
              insert: {
                source: REMOTE_HOSTS,
                ref,
                label,
                appearance: "session",
                clipboardText: ref,
              },
            };
          }

          if (value.startsWith(HARNESS_PREFIX)) {
            const rest = value.slice(HARNESS_PREFIX.length);
            const sep = rest.lastIndexOf(":");
            if (sep <= 0) {
              drilledHost.delete(sessionId);
              deps.notify(sessionId, t("discovery.stale"));
              return "handled";
            }
            const targetHostId = rest.slice(0, sep);
            const harnessId = rest.slice(sep + 1);
            const active = drilledHost.get(sessionId);
            const host =
              active?.hostId === targetHostId
                ? active
                : hostsData
                    .get(deps.hostIdOf(sessionId))
                    ?.find((item) => item.hostId === targetHostId);
            const harness = harnessesData.get(targetHostId)?.find((item) => item.id === harnessId);
            drilledHost.delete(sessionId);
            if (!host || !harness) {
              deps.notify(sessionId, t("discovery.stale"));
              return "handled";
            }
            const chipLabel = `${displayNameOf(host)} · ${harness.name}`;
            const ref = formatDelegationMentionLink({
              hostId: host.hostId,
              harnessId: harness.id,
              label: chipLabel,
            });
            return {
              insert: {
                source: REMOTE_HOSTS,
                ref,
                label: chipLabel,
                appearance: "session",
                clipboardText: ref,
              },
            };
          }

          return "handled";
        },
      }),
    "ui-codexhost: remote host delegation discovery",
  );
}

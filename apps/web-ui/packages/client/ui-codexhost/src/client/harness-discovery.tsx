/** Web product discovery over the existing slash menu and shared Harness catalog. */
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-model-selection/client";
import type {} from "@deepseek-ai/dsh-client-ui-commands/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type {
  CandidateRequest,
  InputTriggerCandidate,
  InputTriggerPick,
} from "@deepseek-ai/dsh-client-ui-input-trigger/client";
import {
  formatDelegationMentionLink,
  REMOTE_PEER_HOST_ID_PREFIX,
  type HarnessCommandDescriptor,
  type HarnessCommandCatalog,
} from "@codexhost/shared-contracts";
import {
  harnessIconSources,
  RemotePluginIcon,
  IconDataOutlineRegular,
  type IconProps,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { harnessCommandApi } from "./api.ts";
import { HARNESS_COMMAND_SOURCE, harnessCommandReference } from "./harness-command-reference.ts";
import { registerRemoteHostDelegation } from "./remote-host-delegation.tsx";
import type {} from "./HostConnectionStatus.tsx";

const AGENTS = "codexhost-delegation";

export function registerHarnessDiscovery(ctx: Context): void {
  const connection = ctx.get("connection") as ConnectionHandle;
  const cache = new Map<
    SessionId,
    {
      epoch: object | undefined;
      generation: number;
      connection: string | undefined;
      harnessId: string | undefined;
      promise: Promise<{ catalog: HarnessCommandCatalog; reserved: ReadonlySet<string> }>;
    }
  >();
  const selected = new WeakMap<
    InputTriggerCandidate,
    { command: HarnessCommandDescriptor; entry: object }
  >();
  const pending = new Set<SessionId>();
  let generation = 0;
  const listeners = new Set<() => void>();
  const t = ctx.locale.bind("codexhostImport");
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const hostIdOf = (id: SessionId) =>
    ctx.sessions.list.getSnapshot().byId[id]?.projectionValues?.threadReference?.hostId ?? "local";
  const isLocal = (id: SessionId) => hostIdOf(id) === "local";
  const isRemotePeer = (id: SessionId) => hostIdOf(id).startsWith(REMOTE_PEER_HOST_ID_PREFIX);
  const harnessIdOf = (id: SessionId) => {
    const row = ctx.sessions.list.getSnapshot().byId[id];
    return (
      (row?.blank ? row.projectionValues?.modelSelection?.next?.provider : undefined) ??
      row?.projectionValues?.harnessIdentity?.id
    );
  };
  const connectionStateOf = (id: SessionId) => {
    const row = ctx.sessions.list.getSnapshot().byId[id];
    return (
      row?.projectionValues?.nativeConnection?.state ?? row?.projectionValues?.remoteHost?.state
    );
  };
  const isDirectCommand = (command: HarnessCommandDescriptor) =>
    command.argumentMode === "none" || command.invocation === "/compact";
  const supported = (id: SessionId) => {
    const row = ctx.sessions.list.getSnapshot().byId[id];
    if (!row || ctx.sessions.subagentAddress(id) !== undefined) return false;
    if (!isLocal(id) && !isRemotePeer(id)) return false;
    // A Codex draft has no Thread yet; the Host lists its workspace Skills from the draft's cwd.
    if (row.blank) return harnessIdOf(id) === "codex";
    return row.projectionValues?.nativeDiscovery === true;
  };
  const directoryOf = (id: SessionId) => {
    if (!ctx.sessions.scope(id) || !ctx.sessions.binding(id)) return undefined;
    try {
      return ctx.modelDirectories.directoryFor(id);
    } catch {
      return undefined;
    }
  };
  const delegationGroupsOf = (id: SessionId) => {
    if (isRemotePeer(id)) {
      return directoryOf(id)?.store.getSnapshot().harnesses ?? [];
    }
    return ctx.modelDirectories.harnessCatalog.getSnapshot().value?.groups ?? [];
  };
  const supportsDelegation = (id: SessionId) => {
    const row = ctx.sessions.list.getSnapshot().byId[id];
    if (!row || ctx.sessions.subagentAddress(id) !== undefined) return false;
    if (isRemotePeer(id)) {
      if (connectionStateOf(id) !== "connected") return false;
      return row.blank || row.projectionValues?.nativeDiscovery === true;
    }
    if (!isLocal(id)) return false;
    if (row.blank) return harnessIdOf(id) != null;
    return row.projectionValues?.nativeDiscovery === true;
  };
  const reason = (id: SessionId): string | undefined => {
    const row = ctx.sessions.list.getSnapshot().byId[id];
    if (
      !connection.generation.getSnapshot() ||
      row?.projectionValues?.nativeConnection?.state === "reconnecting" ||
      (isRemotePeer(id) && connectionStateOf(id) !== "connected")
    )
      return t("discovery.offline");
    if (pending.has(id)) return t("discovery.pending");
    if (row?.running) return t("discovery.busy");
    return undefined;
  };
  const input = (id: SessionId) => {
    const scope = ctx.sessions.scope(id);
    return scope?.get("conversation")?.input.for(scope);
  };
  const notify = (id: SessionId, text: string) => input(id)?.notify("error", text);
  const read = (id: SessionId, req: CandidateRequest) => {
    const harnessId = harnessIdOf(id);
    let entry = cache.get(id);
    if (
      !entry ||
      entry.epoch !== req.menuEpoch ||
      entry.generation !== generation ||
      entry.harnessId !== harnessId
    ) {
      entry = {
        epoch: req.menuEpoch,
        generation,
        connection: connectionStateOf(id),
        harnessId,
        promise: Promise.all([
          harnessCommandApi.inspect(id),
          ctx.commandUi.reservedNames({ sessionId: id }),
        ]).then(([catalog, reserved]) => ({ catalog, reserved })),
      };
      cache.set(id, entry);
    }
    return entry;
  };
  const subscribe = ({ sessionId }: { sessionId: SessionId }, listener: () => void) => {
    listeners.add(listener);
    const off = ctx.sessions.list.subscribe(listener);
    const catalogOff = isRemotePeer(sessionId)
      ? (directoryOf(sessionId)?.store.subscribe(listener) ?? (() => {}))
      : ctx.modelDirectories.harnessCatalog.subscribe(listener);
    return () => {
      listeners.delete(listener);
      off();
      catalogOff();
      cache.delete(sessionId);
    };
  };
  ctx.effect(
    () =>
      connection.generation.subscribe(() => {
        generation++;
        cache.clear();
        changed();
      }),
    "ui-codexhost: browser connection generation",
  );
  ctx.effect(
    () =>
      ctx.remote.$on("codexhost/skills/changed", () => {
        generation++;
        cache.clear();
        changed();
      }),
    "ui-codexhost: skills changed invalidation",
  );
  // Native Host reconnects and draft Harness switches are projected independently of the browser transport.
  ctx.effect(
    () =>
      ctx.sessions.list.subscribe(() => {
        let invalidated = false;
        for (const [id, entry] of cache) {
          if (entry.connection !== connectionStateOf(id) || entry.harnessId !== harnessIdOf(id)) {
            cache.delete(id);
            invalidated = true;
          }
        }
        if (invalidated) changed();
      }),
    "ui-codexhost: discovery connection generation",
  );

  const execute = (pick: InputTriggerPick, commandId: string) => {
    const id = pick.session.sessionId;
    const disabled = reason(id);
    if (!supported(id) || disabled) {
      notify(id, disabled ?? t("discovery.stale"));
      return;
    }
    const scope = ctx.sessions.scope(id);
    const composer = input(id);
    if (!scope || composer?.state.getSnapshot().draftRev !== pick.span.draftRev) return;
    if (
      pick.span.start !== pick.span.end &&
      scope.bail(scope, "slash/input-consume-token", {
        guard: { kind: "span", span: pick.span },
      }) !== true
    )
      return;
    pending.add(id);
    changed();
    // Never resend after an uncertain write. Accepted is admission; the Thread renders progress.
    void harnessCommandApi
      .execute(id, commandId)
      .catch((error: unknown) =>
        notify(
          id,
          `${t("discovery.unconfirmed")} ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      .finally(() => {
        pending.delete(id);
        changed();
      });
  };

  ctx.effect(
    () =>
      ctx.inputTriggers.registerSource({
        trigger: "/",
        aliases: ["#", "@"],
        name: HARNESS_COMMAND_SOURCE,
        codec: { clipboardText: (ref) => ref, serialize: async (ref) => ref },
        launcher: "command",
        order: 20,
        showGroupTitle: false,
        subscribeCandidates: subscribe,
        candidates: async ({ sessionId }, req) => {
          if (!supported(sessionId)) return [];
          if (!connection.generation.getSnapshot())
            return [
              {
                name: t("discovery.retry"),
                value: "retry",
                section: t("discovery.commands"),
                description: t("discovery.offline"),
              },
            ];
          const entry = read(sessionId, req);
          try {
            const { catalog, reserved } = await entry.promise;
            if (cache.get(sessionId) !== entry || !supported(sessionId)) return [];
            const query = req.query.toLocaleLowerCase();
            const codex = harnessIdOf(sessionId) === "codex";
            const rows: InputTriggerCandidate[] = catalog.commands
              .filter((command) =>
                `${command.invocation} ${command.label}`.toLocaleLowerCase().includes(query),
              )
              .map((command) => {
                const nativeCodexSkill = codex && command.kind === "skill";
                const disabledReason = reserved.has(command.invocation)
                  ? t("discovery.conflict")
                  : isDirectCommand(command)
                    ? reason(sessionId)
                    : undefined;
                const row: InputTriggerCandidate = {
                  name: command.invocation,
                  label: nativeCodexSkill
                    ? command.label.replace(/^\/?skill:/iu, "")
                    : command.label,
                  showAlias: !nativeCodexSkill,
                  value: command.id,
                  section: t(nativeCodexSkill ? "discovery.skills" : "discovery.commands"),
                  description: command.description,
                  ...(disabledReason ? { disabledReason } : {}),
                };
                selected.set(row, { command, entry });
                return row;
              });
            if (catalog.warnings?.length && !query)
              rows.push({
                name: t("discovery.retry"),
                value: "retry",
                section: t("discovery.commands"),
                description: catalog.warnings.join("\n"),
              });
            if (catalog.source === "static" && !query)
              rows.push({
                name: t("discovery.static"),
                disabledReason: t("discovery.static"),
                section: t("discovery.commands"),
              });
            if (!catalog.commands.length && !query && catalog.source !== "static")
              rows.push({
                name: t("discovery.empty"),
                disabledReason: t("discovery.empty"),
                section: t("discovery.commands"),
              });
            return codex
              ? rows.toSorted(
                  (a, b) =>
                    Number(a.section === t("discovery.skills")) -
                    Number(b.section === t("discovery.skills")),
                )
              : rows;
          } catch (error) {
            if (cache.get(sessionId) !== entry) return [];
            return [
              {
                name: t("discovery.retry"),
                value: "retry",
                section: t("discovery.commands"),
                description: `${t("discovery.failed")} ${error instanceof Error ? error.message : String(error)}`,
              },
            ];
          }
        },
        onPick: (pick) => {
          const id = pick.session.sessionId;
          if (!supported(id)) {
            notify(id, t("discovery.stale"));
            return "handled";
          }
          if (pick.candidate.value === "retry") {
            cache.delete(id);
            return "refresh";
          }
          const entry = cache.get(id);
          if (!entry || entry.generation !== generation) {
            notify(id, t("discovery.stale"));
            return "handled";
          }
          // Rows carry stable IDs. Re-read the exact snapshot synchronously before any edit or write.
          const commandId = pick.candidate.value;
          if (!commandId) return "handled";
          if (pick.candidate.disabledReason) return "handled";
          // Descriptor metadata is retained alongside the row, never guessed from its label.
          const snapshot = selected.get(pick.candidate);
          const command = snapshot?.entry === entry ? snapshot.command : undefined;
          if (!command) {
            notify(id, t("discovery.stale"));
            return "handled";
          }
          if (isDirectCommand(command)) {
            execute(pick, commandId);
            return "handled";
          }
          try {
            return { insert: harnessCommandReference(command.invocation) };
          } catch {
            notify(id, t("discovery.stale"));
            return "handled";
          }
        },
      }),
    "ui-codexhost: native discovery",
  );

  ctx.effect(
    () =>
      ctx.inputTriggers.registerSource({
        trigger: "@",
        aliases: ["#"],
        name: AGENTS,
        launcher: "command",
        launcherOrder: 30,
        order: 10,
        showGroupTitle: false,
        codec: { clipboardText: (ref) => ref, serialize: async (ref) => ref },
        subscribeCandidates: subscribe,
        candidates: async ({ sessionId }, req) => {
          if (!supportsDelegation(sessionId)) return [];
          const remotePeer = isRemotePeer(sessionId);
          let groups = delegationGroupsOf(sessionId);
          if (remotePeer) {
            const directory = directoryOf(sessionId);
            const snapshot = directory?.store.getSnapshot();
            if (
              directory &&
              snapshot &&
              snapshot.harnesses.length === 0 &&
              snapshot.status !== "error"
            ) {
              await directory.load().catch(() => null);
              req.signal.throwIfAborted();
              if (!supportsDelegation(sessionId)) return [];
              groups = directory.store.getSnapshot().harnesses;
            }
          }
          const iconHostId = remotePeer ? hostIdOf(sessionId) : undefined;
          const query = req.query.toLocaleLowerCase();
          return groups
            .filter((group) => `${group.name} ${group.id}`.toLocaleLowerCase().includes(query))
            .map((group) => ({
              name: group.id,
              label: group.name,
              value: group.id,
              section: t("discovery.agents"),
              icon: harnessAgentIcon(group.id, iconHostId),
            }));
        },
        onPick: (pick) => {
          const group = delegationGroupsOf(pick.session.sessionId).find(
            (item) => item.id === pick.candidate.value,
          );
          if (!supportsDelegation(pick.session.sessionId) || !group) {
            notify(pick.session.sessionId, t("discovery.stale"));
            return "handled";
          }
          const ref = formatDelegationMentionLink({ harnessId: group.id, label: group.name });
          return {
            insert: {
              source: AGENTS,
              ref,
              label: group.name,
              appearance: "session",
              clipboardText: ref,
            },
          };
        },
      }),
    "ui-codexhost: delegation discovery",
  );

  registerRemoteHostDelegation(ctx, { hostIdOf, supportsDelegation, notify });
}

type AgentIconComponent = Exclude<InputTriggerCandidate["icon"], string | undefined>;
const agentIconCache = new Map<string, AgentIconComponent>();

/** Return a stable icon component per Harness icon identity so menu filtering never remounts icons. */
export function harnessAgentIcon(harnessId: string, hostId?: string): AgentIconComponent {
  const icon = harnessIconSources(harnessId, hostId);
  const key = `${harnessId}\0${hostId ?? ""}\0${icon.src ?? ""}\0${icon.presentationUrl ?? ""}`;
  const cached = agentIconCache.get(key);
  if (cached !== undefined) return cached;
  const HarnessAgentIcon: AgentIconComponent = (props: IconProps) => (
    <RemotePluginIcon
      id={harnessId}
      src={icon.src}
      presentationUrl={icon.presentationUrl}
      size={props.size ?? 14}
      fallback={<IconDataOutlineRegular size={props.size ?? 14} />}
    />
  );
  agentIconCache.set(key, HarnessAgentIcon);
  return HarnessAgentIcon;
}

import type { Context } from "@deepseek-ai/cordis";
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type {
  CandidateRequest,
  InputTriggerCandidate,
} from "@deepseek-ai/dsh-client-ui-input-trigger/client";
import { IconSkillOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import {
  formatSkillReference,
  SKILL_REFERENCE_SOURCE,
  type LibrarySkill,
  type SkillsListResult,
} from "@codexhost/shared-contracts";
import { skillLibraryApi } from "./api.ts";

/** One memory snapshot per open menu; typing filters it without additional requests. */
export function registerSkillLibrary(ctx: Context): void {
  const connection = ctx.get("connection") as ConnectionHandle;
  const cache = new Map<
    SessionId,
    { epoch: object | undefined; promise: Promise<SkillsListResult> }
  >();
  const selected = new WeakMap<InputTriggerCandidate, { skill: LibrarySkill; entry: object }>();
  const listeners = new Set<() => void>();
  const t = ctx.locale.bind("codexhostImport");
  const supported = (id: SessionId) => {
    const row = ctx.sessions.list.getSnapshot().byId[id];
    const identity = row?.projectionValues?.harnessIdentity;
    return (
      !!identity &&
      identity.id !== "codex" &&
      (row.blank || row.projectionValues?.nativeDiscovery === true) &&
      (row.projectionValues?.threadReference?.hostId ?? "local") === "local" &&
      ctx.sessions.subagentAddress(id) === undefined
    );
  };
  const invalidate = () => {
    cache.clear();
    for (const listener of listeners) listener();
  };
  ctx.effect(() => connection.generation.subscribe(invalidate));
  ctx.effect(() => ctx.remote.$on("codexhost/skills/changed", invalidate));
  const read = (id: SessionId, req: CandidateRequest) => {
    let entry = cache.get(id);
    if (!entry || entry.epoch !== req.menuEpoch) {
      entry = { epoch: req.menuEpoch, promise: skillLibraryApi.list(id) };
      cache.set(id, entry);
    }
    return entry;
  };
  ctx.effect(() =>
    ctx.inputTriggers.registerSource({
      trigger: "/",
      aliases: ["@", "#"],
      name: SKILL_REFERENCE_SOURCE,
      order: 30,
      launcher: "command",
      showGroupTitle: false,
      codec: { clipboardText: (ref) => ref, serialize: async (ref) => ref },
      subscribeCandidates: ({ sessionId }, listener) => {
        listeners.add(listener);
        const off = ctx.sessions.list.subscribe(listener);
        return () => {
          listeners.delete(listener);
          cache.delete(sessionId);
          off();
        };
      },
      candidates: async ({ sessionId }, req) => {
        if (!supported(sessionId)) return [];
        const entry = read(sessionId, req);
        try {
          const result = await entry.promise;
          if (cache.get(sessionId) !== entry || !supported(sessionId)) return [];
          const query = req.query.toLocaleLowerCase();
          const rows: InputTriggerCandidate[] = result.skills
            .filter((skill) =>
              `${skill.name} ${skill.description ?? ""}`.toLocaleLowerCase().includes(query),
            )
            .map((skill) => {
              const row: InputTriggerCandidate = {
                name: skill.name,
                value: skill.path,
                section: t("discovery.skills"),
                icon: IconSkillOutlineRegular,
                description: `${skill.scope === "project" ? t("skills.project") : t("skills.global")} · ${skill.source} · ${skill.path}${skill.description ? ` — ${skill.description}` : ""}`,
              };
              selected.set(row, { skill, entry });
              return row;
            });
          if (!result.complete && !query)
            rows.push({
              name: t("skills.loading"),
              disabledReason: t("skills.loading"),
              section: t("discovery.skills"),
            });
          if (result.warnings?.length)
            rows.push({
              name: t("skills.warnings"),
              disabledReason: result.warnings.join("\n"),
              description: result.warnings.join("\n"),
              section: t("discovery.skills"),
            });
          return rows;
        } catch (error) {
          if (cache.get(sessionId) !== entry) return [];
          return [
            {
              name: t("skills.retry"),
              value: "retry",
              section: t("discovery.skills"),
              description: `${t("skills.failed")} ${error instanceof Error ? error.message : String(error)}`,
            },
          ];
        }
      },
      onPick: (pick) => {
        const id = pick.session.sessionId;
        if (!supported(id)) return "handled";
        if (pick.candidate.value === "retry") {
          cache.delete(id);
          return "refresh";
        }
        const selectedSkill = selected.get(pick.candidate);
        if (!selectedSkill || selectedSkill.entry !== cache.get(id)) return "handled";
        const skill = selectedSkill.skill;
        const ref = formatSkillReference(skill);
        return {
          insert: {
            source: SKILL_REFERENCE_SOURCE,
            ref,
            label: skill.name,
            appearance: "skill",
            clipboardText: ref,
          },
        };
      },
    }),
  );
}

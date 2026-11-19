/** Native permission controls share one session projection and the existing Adapter command path. */
import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type { SessionFace } from "@deepseek-ai/dsh-api-session-controller/client";
import type { SessionId } from "@deepseek-ai/dsh-api-remotes/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type { CommandUiContract, SelectOption } from "@deepseek-ai/dsh-client-ui-commands/client";
import { PermissionSelect, type PermissionSelectInjected } from "./PermissionSelect.tsx";
import type { NativePermissions } from "./native.ts";
import { accessEn, accessZh, PERMISSION_ACCESS_NS } from "./locales.ts";

export type { PermissionRowInjected, PermissionRowProps } from "./PermissionRow.tsx";
export type { PermissionCatalogState } from "./catalog.ts";
export type { PermissionSelectInjected, PermissionSelectProps } from "./PermissionSelect.tsx";
export type { PermissionDefaultOption, PermissionSettingsState } from "./settings-store.ts";

export const inject = ["commandUi", "sessions", "slots", "locale", "remote", "remote.commands"];

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    "permission.access": keyof typeof accessEn;
  }
}

function nativeOf(session: SessionFace | undefined): NativePermissions | null | undefined {
  return session?.projections.faceOf("nativePermissions").getSnapshot() as
    NativePermissions | null | undefined;
}

/** Mount native choices only where the current Harness advertises them.
 * @param ctx Browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const command = ctx.get("commandUi") as CommandUiContract;
  const sessions = ctx.sessions;
  ctx.effect(
    () => ctx.locale.register(PERMISSION_ACCESS_NS, { zh: accessZh, en: accessEn }),
    "ui-permission: native dictionaries",
  );
  const t = ctx.locale.bind(PERMISSION_ACCESS_NS);
  const submit = async (sessionId: SessionId, modeId: string): Promise<boolean> => {
    if (sessions.binding(sessionId) === undefined)
      throw new Error("This session is not materialized yet.");
    const native = nativeOf(sessions.binding(sessionId)?.session);
    if (
      !native?.selectable ||
      native.locked ||
      !native.catalog?.modes.some((mode) => mode.id === modeId)
    )
      throw new Error("Native permission mode selection is unavailable for this session.");
    const result = await ctx.remote.commands.execute(sessionId, `/permission ${modeId}`, []);
    if (!result.ok) throw new Error(result.error.message);
    if (result.value === undefined) throw new Error("The Host offers no /permission command.");
    if (result.value.result?.kind === "error")
      throw new Error(result.value.result.text ?? "Native permission switch failed.");
    return true;
  };
  ctx.slots.inject("conversation.input.permission", () =>
    ctx.slots.register(
      {
        name: "conversation.input.permission",
        locale: PERMISSION_ACCESS_NS,
        inject: (sessionId: SessionId): PermissionSelectInjected => ({
          select: (modeId) => submit(sessionId, modeId),
        }),
      },
      PermissionSelect,
    ),
  );
  ctx.effect(
    () =>
      command.decorate({
        name: "permission",
        available: (session) => {
          const native = nativeOf(sessions.binding(session.sessionId)?.session);
          return native?.selectable === true && !native.locked;
        },
        ui: {
          kind: "popupSelect",
          options: async (session) => {
            const live = sessions.binding(session.sessionId)?.session;
            const native = nativeOf(live);
            if (!native?.selectable || native.locked || !native.catalog)
              throw new Error("Native permissions unavailable.");
            const current = live?.projections.faceOf("permissions").getSnapshot() as
              { currentValue: string } | undefined;
            return native.catalog.modes.map((mode): SelectOption => ({
              id: mode.id,
              label: mode.label,
              ...(mode.description ? { detail: mode.description } : {}),
              ...(mode.id === current?.currentValue ? { active: true } : {}),
              ...(mode.dangerous
                ? {
                    confirmation: {
                      title: t("native.confirm.title", { name: mode.label }),
                      description: mode.description ?? t("native.confirm.description"),
                      acknowledgeLabel: t("confirm.acknowledge"),
                      cancelLabel: t("confirm.cancel"),
                      confirmLabel: t("native.confirm.enable"),
                    },
                  }
                : {}),
            }));
          },
          onSelect: (option, session) => submit(session.sessionId, option.id).then(() => undefined),
        },
      }),
    "ui-permission: native /permission picker",
  );
}

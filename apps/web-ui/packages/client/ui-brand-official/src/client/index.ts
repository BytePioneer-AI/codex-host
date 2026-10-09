/** CodexHost occupants for the generic browser-brand slots. */
import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import { CodexHostMark, CodexHostName } from "./Brand.tsx";

/** Required service: the UI slot registry. */
export const inject = ["slots"];

/**
 * Fill the sidebar brand slots and the empty-conversation hero mark.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject("sidebar.brand.mark", () =>
    ctx.slots.inject("sidebar.brand.name", function* () {
      yield ctx.slots.register({ name: "sidebar.brand.mark" }, CodexHostMark);
      yield ctx.slots.register({ name: "sidebar.brand.name" }, CodexHostName);
    }),
  );
  ctx.slots.inject("conversation.hero.brand.mark" as "sidebar.brand.mark", () =>
    ctx.slots.register(
      { name: "conversation.hero.brand.mark" as "sidebar.brand.mark" },
      CodexHostMark,
    ),
  );
}

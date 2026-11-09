import {
  webUiExtensionInstallSchema,
  webUiExtensionEnabledSchema,
  webUiExtensionRemoveSchema,
} from "@codexhost/shared-contracts";
import { RpcError, type RpcRegistry, type RpcContext } from "./transport.ts";
import type { WebUiExtensions } from "./ui-extensions.ts";

export function registerUiExtensionRpc(
  rpc: RpcRegistry,
  extensions: WebUiExtensions,
  options: { port: () => number },
): void {
  const local = (context: RpcContext): void => {
    if (context.auth?.local !== true)
      throw new RpcError(
        "auth/local-access-required",
        "Web extensions can only be managed on this computer.",
        { url: `http://127.0.0.1:${String(options.port())}` },
      );
  };
  const mutate = async (context: RpcContext, operation: () => Promise<unknown>) => {
    local(context);
    try {
      return await operation();
    } catch (error) {
      throw new RpcError(
        "extensions/change-failed",
        error instanceof Error ? error.message : "Extension operation failed.",
        {},
      );
    }
  };
  rpc.register("codexhost/uiExtensions/list", (_args, context) => {
    local(context);
    return extensions.state();
  });
  rpc.register("codexhost/uiExtensions/install", (args, context) =>
    mutate(context, () => {
      const { spec, registry } = webUiExtensionInstallSchema.parse(args);
      return extensions.install(spec, registry);
    }),
  );
  rpc.register("codexhost/uiExtensions/setEnabled", (args, context) =>
    mutate(context, () => {
      const { id, enabled } = webUiExtensionEnabledSchema.parse(args);
      return extensions.setEnabled(id, enabled);
    }),
  );
  rpc.register("codexhost/uiExtensions/remove", (args, context) =>
    mutate(context, () => extensions.remove(webUiExtensionRemoveSchema.parse(args).id)),
  );
}

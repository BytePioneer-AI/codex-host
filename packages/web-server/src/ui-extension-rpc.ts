import {
  webUiExtensionInstallSchema,
  webUiExtensionEnabledSchema,
  webUiExtensionRemoveSchema,
} from "@codexhost/shared-contracts";
import { RpcError, type RpcRegistry, type RpcContext } from "./transport.ts";
import type { WebUiExtensions } from "./ui-extensions.ts";

export function registerUiExtensionRpc(rpc: RpcRegistry, extensions: WebUiExtensions): void {
  const authenticated = (context: RpcContext): void => {
    if (context.auth === undefined)
      throw new RpcError(
        "auth/disabled",
        "Authentication must be enabled to manage Web extensions.",
        {},
      );
  };
  const mutate = async (context: RpcContext, operation: () => Promise<unknown>) => {
    authenticated(context);
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
    authenticated(context);
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

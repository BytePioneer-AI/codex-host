/** Installed Web plugins share the embedded host's framework packages, not downloaded peers. */
import { realpathSync } from "node:fs";
import { isBuiltin, registerHooks } from "node:module";
import { basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";

/** Runtime packages shipped as shared modules in the Web distribution. */
export const WEB_RUNTIME_PACKAGES = [
  "@deepseek-ai/cordis",
  "@deepseek-ai/cosmokit",
  "@deepseek-ai/schemastery",
  "@deepseek-ai/cordis-plugin-loader",
  "@codexhost/dsh-web-include",
  "@deepseek-ai/dsh-host-webserver",
  "@deepseek-ai/dsh-client-modules",
] as const;

/** The public DSH name resolves to Web's private workspace package. */
export const WEB_RUNTIME_ALIASES: Readonly<Record<string, string>> = {
  "@deepseek-ai/cordis-plugin-include": "@codexhost/dsh-web-include",
};

// From DSH app-boot/profile-resolution/resolver.ts. Keep Node's own handling of
// relative paths, package imports, built-ins, and URL specifiers.
function barePackageName(request: string): string | undefined {
  if (
    !request ||
    request[0] === "." ||
    request[0] === "/" ||
    request[0] === "\\" ||
    request[0] === "#" ||
    request.includes(":") ||
    isBuiltin(request)
  )
    return;
  const first = request.indexOf("/");
  if (request[0] !== "@") return first < 0 ? request : request.slice(0, first);
  if (first < 0) return;
  const second = request.indexOf("/", first + 1);
  return second < 0 ? request : request.slice(0, second);
}

/** Include dependencies beside an installed package, without affecting other installations. */
function installationUrl(directory: string): string {
  let current = directory;
  while (dirname(current) !== current) {
    if (basename(current) === "node_modules") return pathToFileURL(current + "/").href;
    current = dirname(current);
  }
  return pathToFileURL(directory + "/").href;
}

/** Route only selected installations' framework imports; unregister with their lifecycle. */
export function sharePluginRuntime(directories: readonly string[]): () => void {
  const roots = directories.flatMap((directory) => [
    installationUrl(directory),
    installationUrl(realpathSync(directory)),
  ]);
  const shared = new Set<string>([...WEB_RUNTIME_PACKAGES, ...Object.keys(WEB_RUNTIME_ALIASES)]);
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      const name = barePackageName(specifier);
      if (
        name !== undefined &&
        shared.has(name) &&
        context.parentURL !== undefined &&
        roots.some((root) => context.parentURL!.startsWith(root))
      ) {
        const target = WEB_RUNTIME_ALIASES[name];
        return nextResolve(target ? target + specifier.slice(name.length) : specifier, {
          ...context,
          parentURL: import.meta.url,
        });
      }
      return nextResolve(specifier, context);
    },
  });
  return () => hook.deregister();
}

import { environmentValue, targetPath } from "@codexhost/harness-discovery";
import { ZcodeError } from "./errors.js";

const BUILTIN_CONFIG = "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE";
const PERSONAL_CONFIG = "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE";
const BUNDLED_CONFIG = "ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE";

/** Supply only the missing Desktop bundle location; ZCode still owns config loading and refresh. */
export function zcodeProviderEnvironment(
  script: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  readable: (file: string) => boolean,
): NodeJS.ProcessEnv {
  // Do not reinterpret explicit native Provider configuration, including partial overrides.
  if (
    [BUILTIN_CONFIG, PERSONAL_CONFIG, BUNDLED_CONFIG].some((key) =>
      environmentValue(environment, key)?.trim(),
    )
  )
    return environment;

  const paths = targetPath(platform);
  const directory = paths.dirname(script);
  const resources = paths.dirname(directory);
  // Only the selected Desktop's known layout. Standalone/custom scripts retain their semantics.
  if (
    paths.basename(script).toLowerCase() !== "zcode.cjs" ||
    paths.basename(directory).toLowerCase() !== "glm" ||
    paths.basename(resources).toLowerCase() !== "resources"
  )
    return environment;

  // These are the native script's existing lookup locations. Preserve working installations.
  const nativeCandidates = [
    paths.join(directory, "provider", "zcode-builtin.json"),
    paths.resolve(directory, "../../../../../config/provider/zcode-builtin.json"),
  ];
  if (nativeCandidates.some(readable)) return environment;

  const bundled = paths.join(resources, "config", "provider", "zcode-builtin.json");
  if (!readable(bundled)) {
    throw new ZcodeError(
      "unavailable",
      "ZCode installation is missing its bundled provider configuration (zcode-builtin.json)",
    );
  }
  // With no personal-config override, native bootstrap treats this as its bundled source,
  // prepares its own active cache and selects its own personal configuration path.
  // Do not set PERSONAL_CONFIG as well: that would bypass native cache initialization.
  return { ...environment, [BUILTIN_CONFIG]: bundled };
}

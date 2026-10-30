import * as globalSdk from "@qoder-ai/qoder-agent-sdk";
import * as cnSdk from "@qodercn-ai/qodercn-agent-sdk";

export type QoderVariant = "global" | "cn";

// Both distributions expose the same SDK API, but own different CLI/auth/history defaults.
// Select the entire SDK, not just query(), so history and forks stay in the same distribution.
export const QODER_RUNTIMES = {
  global: {
    harnessId: "qoder",
    sdk: globalSdk,
    commandEnvironmentVariable: "CODEXHOST_QODER_COMMAND",
    accessTokenEnvironmentVariable: "QODER_PERSONAL_ACCESS_TOKEN",
  },
  cn: {
    harnessId: "qoder-cn",
    sdk: cnSdk,
    commandEnvironmentVariable: "CODEXHOST_QODERCN_COMMAND",
    accessTokenEnvironmentVariable: "QODERCN_PERSONAL_ACCESS_TOKEN",
  },
} as const;

export function qoderAuthForEnvironment(
  variant: QoderVariant,
  environment: Record<string, string | undefined>,
) {
  const runtime = QODER_RUNTIMES[variant];
  return environment[runtime.accessTokenEnvironmentVariable]
    ? runtime.sdk.accessTokenFromEnv()
    : runtime.sdk.qodercliAuth();
}

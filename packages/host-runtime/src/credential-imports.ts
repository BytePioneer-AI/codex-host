import type { HarnessAdapter, HarnessCredentialTransfer } from "@codexhost/harness-adapter";
import {
  credentialImportsParamsSchema,
  credentialImportsResultSchema,
  type CredentialImportsResult,
  type CredentialOtherLogin,
} from "@codexhost/shared-contracts";
import { readCodexCredential } from "./account/codex-credential-export.js";

/** Metadata-only response; all credential material remains in backend memory. */
export async function handleCredentialImports(
  params: unknown,
  adapters: Iterable<HarnessAdapter>,
  environment: NodeJS.ProcessEnv,
): Promise<CredentialImportsResult> {
  const input = credentialImportsParamsSchema.parse(params);
  const installed = [...adapters];
  const sources: HarnessCredentialTransfer[] = await readCodexCredential(environment);
  for (const adapter of installed) {
    if (adapter.credentialExport) sources.push(...(await adapter.credentialExport.read()));
  }
  const request = input.request;
  if (request.action !== "list") {
    const target = installed.find((a) => a.harnessId === input.targetHarnessId)?.credentialImports;
    if (!target) throw new Error("Target Harness does not support credential imports");
    if (request.action === "remove") await target.remove(request.name);
    else {
      const source = sources.find((s) => s.source.id === request.sourceId);
      if (!source || !target.providers.includes(source.source.provider))
        throw new Error("Source login changed or is unavailable; refresh and confirm again");
      if (request.action === "reimport") await target.reimport(request.name, source);
      else await target.add(request.name, source);
    }
  }
  const targets: CredentialImportsResult["targets"] = [];
  for (const adapter of installed) {
    if (!adapter.credentialImports) continue;
    try {
      targets.push({
        harnessId: adapter.harnessId,
        providers: [...adapter.credentialImports.providers],
        imports: await adapter.credentialImports.list(),
        others: await listOthers(adapter),
      });
    } catch {
      // Missing/unsupported installations are not actionable targets. Never expose SDK errors or tokens.
    }
  }
  return credentialImportsResultSchema.parse({ sources: sources.map((s) => s.source), targets });
}

/** Other logins are informational; failing to read them must never hide the import list. */
async function listOthers(adapter: HarnessAdapter): Promise<CredentialOtherLogin[]> {
  try {
    return (await adapter.credentialImports?.listOthers?.()) ?? [];
  } catch {
    return [];
  }
}

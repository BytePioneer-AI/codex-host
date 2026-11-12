import type { SkillLibrary } from "@codexhost/skill-library";
import type { JsonRpcRequest, JsonValue } from "@codexhost/protocol-core";
import {
  jsonValueSchema,
  skillsListParamsSchema,
  skillsListResultSchema,
} from "@codexhost/shared-contracts";
import { rpcEnvelope, rpcError } from "./desktop-rpc.js";
import type { ExternalThreadLocation } from "./external-thread-runtime.js";

/** Workspace resolution reads ownership metadata only, never opens a Native Session. */
export async function handleSkillsList(
  request: JsonRpcRequest,
  library: SkillLibrary,
  host: {
    locate(threadId: string): Promise<ExternalThreadLocation>;
    write(value: JsonValue): Promise<void>;
  },
): Promise<void> {
  const parsed = skillsListParamsSchema.safeParse(request.params ?? {});
  if (!parsed.success) {
    await host.write(rpcError(request, -32602, "Invalid Skill Library query"));
    return;
  }
  let cwd = parsed.data.cwd;
  if (parsed.data.threadId) {
    const location = await host.locate(parsed.data.threadId);
    if (location.kind !== "external" || location.record.subagent) {
      await host.write(rpcError(request, -32078, "Skill Library requires a local external Thread"));
      return;
    }
    cwd = location.record.cwd;
  }
  const result = skillsListResultSchema.parse(await library.list({ cwd }));
  await host.write(rpcEnvelope(request, { result: jsonValueSchema.parse(result) }));
}

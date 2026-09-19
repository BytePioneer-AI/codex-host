import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HermesGatewayTransport } from "./gateway-transport.js";

// Use Hermes's provider-aware parser: a named provider and an Ollama model can
// both contain ':'. Splitting the opaque native choice in JavaScript is lossy.
export async function resolveGatewayModel(
  transport: HermesGatewayTransport,
  modelId: string,
): Promise<{ provider: string; model: string }> {
  if (/\s/u.test(modelId) || modelId.startsWith("-"))
    throw new Error("Invalid Hermes Model identifier");
  const result = await promisify(execFile)(
    transport.python,
    [
      "-I",
      "-c",
      "import json,sys\nfrom hermes_cli.models import parse_model_input\np,m=parse_model_input(sys.argv[1], '')\nprint(json.dumps({'provider':p,'model':m}))",
      modelId,
    ],
    {
      cwd: transport.cwd,
      env: { ...process.env, ...transport.environment },
      timeout: 20000,
      maxBuffer: 1024 * 1024,
    },
  );
  const value: unknown = JSON.parse(result.stdout.trim());
  if (
    !value ||
    typeof value !== "object" ||
    !("provider" in value) ||
    !("model" in value) ||
    typeof value.provider !== "string" ||
    typeof value.model !== "string"
  )
    throw new Error("Hermes returned an invalid Model choice");
  return { provider: value.provider, model: value.model };
}

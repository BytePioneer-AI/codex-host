import fs from "node:fs";
import path from "node:path";

import { GATE_C_SCHEMA_VERSION, rawCaptureSchema } from "./contracts.mjs";
import { assertLocalEvidencePath } from "./workspace.mjs";

export function createCaptureRecorder() {
  const frames = [];
  return {
    frames,
    record(frame) {
      frames.push(structuredClone(frame));
    },
  };
}

export function writeRawCapture(repositoryRoot, outputPath, capture) {
  const safePath = assertLocalEvidencePath(repositoryRoot, outputPath);
  const parsed = rawCaptureSchema.parse({
    schemaVersion: GATE_C_SCHEMA_VERSION,
    captureType: "pi-rpc-scenario",
    ...capture,
  });
  fs.mkdirSync(path.dirname(safePath), { recursive: true });
  fs.writeFileSync(safePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return safePath;
}

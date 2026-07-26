import { applyPatch } from "diff";

export function verifyUnifiedPatch(before, patch, actual) {
  if (typeof patch !== "string" || !patch.includes("@@")) return false;
  const applied = applyPatch(before, patch);
  return typeof applied === "string" && applied === actual;
}

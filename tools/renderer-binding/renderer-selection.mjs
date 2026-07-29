export function selectRendererWebContents(contents) {
  const candidates = contents
    .filter(
      (item) =>
        item.type === "window" &&
        item.surface === "primary" &&
        item.runtime.available &&
        item.runtime.elementCount !== null,
    )
    .toSorted((left, right) => right.runtime.elementCount - left.runtime.elementCount);
  const selected = candidates[0];
  return selected && selected.runtime.elementCount >= 50 ? selected : null;
}

export async function waitForRendererTitlePolicyReady(
  markReadiness,
  {
    timeoutMs = 30_000,
    pollIntervalMs = 250,
    now = Date.now,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  const deadline = now() + timeoutMs;
  let lastError = null;
  while (now() < deadline) {
    try {
      return await markReadiness();
    } catch (error) {
      lastError = error;
    }
    await sleep(pollIntervalMs);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Renderer title policy ownership did not become ready${detail}`);
}

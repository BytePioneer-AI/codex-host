/** Shared preference mutations use the Web auth/same-origin RPC gate. */
export async function preferenceCall<T>(method: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetch(`api/codexhost/preferences/${method}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "client-request",
      rpcId: crypto.randomUUID(),
      method: `codexhost/preferences/${method}`,
      payload: { args },
    }),
  });
  if (!response.ok) throw new Error("Shared Harness preferences are unavailable.");
  const envelope = (await response.json()) as {
    result: { ok: boolean; value: T; error?: { message: string } };
  };
  if (!envelope.result.ok)
    throw new Error(
      envelope.result.error?.message ?? "Shared Harness preferences could not be saved.",
    );
  return envelope.result.value;
}

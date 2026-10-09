/** Thin client for the CodexHost server's `codexhost/*` RPC methods. */

export interface ImportSource {
  harnessId: string;
  name: string;
}

export interface ImportCandidate {
  harnessId: string;
  nativeSessionId: string;
  title: string | null;
  cwd: string;
  updatedAt: number;
  imported?: string;
}

async function call<T>(method: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetch(`api/${method}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "client-request",
      rpcId: crypto.randomUUID(),
      method,
      payload: { args },
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  const envelope = (await response.json()) as {
    result: { ok: true; value: T } | { ok: false; error: { message: string } };
  };
  if (!envelope.result.ok) throw new Error(envelope.result.error.message);
  return envelope.result.value;
}

export const pushApi = {
  config: () => call<{ publicKey: string; subscriptions: number }>("codexhost/pushConfig", {}),
  subscribe: (subscription: PushSubscriptionJSON) =>
    call<{ subscribed: boolean }>("codexhost/pushSubscribe", {
      subscription,
      userAgent: navigator.userAgent,
    }),
  unsubscribe: (endpoint: string) =>
    call<{ subscribed: boolean }>("codexhost/pushUnsubscribe", { endpoint }),
  test: () => call<{ sent: number }>("codexhost/pushTest", {}),
};

export const importApi = {
  sources: () => call<{ sources: ImportSource[] }>("codexhost/importSources", {}),
  candidates: (harnessId: string, query: string, limit: number) =>
    call<{ items: ImportCandidate[]; total: number }>("codexhost/importCandidates", {
      request: { harnessId, query, limit },
    }),
  importSession: (harnessId: string, nativeSessionId: string) =>
    call<{ sessionId: string; created: boolean }>("codexhost/import", {
      request: { harnessId, nativeSessionId },
    }),
};

import type { ExternalRendererAgent } from "../agent-selection-state.js";
import type { RendererConnectionDiagnostics } from "./connections-page.js";

type InstallState = { status: "installing" | "checking" | "error"; error?: string };

// Connection-owned, not page-owned: switching Hosts or closing settings does not
// cancel a request or lose its result. No commands or install sources live here.
function errorMessage(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message.slice(0, 2048)
    : "Could not install the Harness. Check the official installation guide and retry.";
}

const stores = new WeakMap<RendererConnectionDiagnostics, ReturnType<typeof createStore>>();
function createStore(diagnostics: RendererConnectionDiagnostics) {
  const states = new Map<string, InstallState>();
  const listeners = new Set<() => void>();
  const key = (host: string, agent: ExternalRendererAgent) => JSON.stringify([host, agent]);
  const notify = () => listeners.forEach((listener) => listener());
  return {
    get: (host: string, agent: ExternalRendererAgent) => states.get(key(host, agent)),
    clearErrors() {
      for (const [id, state] of states) if (state.status === "error") states.delete(id);
      notify();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async install(host: string, agent: ExternalRendererAgent) {
      const id = key(host, agent);
      const previous = states.get(id);
      if (!diagnostics.installation || (previous && previous.status !== "error")) return;
      states.set(id, { status: "installing" });
      notify();
      let failure: string | undefined;
      try {
        await diagnostics.installation(host, agent, "install");
        states.set(id, { status: "checking" });
        notify();
      } catch (error) {
        failure = errorMessage(error);
      }
      // A failed installer may still have written a usable CLI; never assume it
      // remains absent, nor call a successful CLI install authenticated/ready.
      try {
        await diagnostics.refresh(host);
        const refreshed = diagnostics
          .snapshot()
          .hosts.find((candidate) => candidate.hostId === host)
          ?.agents.find((candidate) => candidate.agent === agent);
        // A successful fresh diagnosis is authoritative even when version
        // readback (e.g. its latest-version endpoint) failed after installation.
        if (refreshed?.availability === "ready") failure = undefined;
      } catch (error) {
        failure ??= errorMessage(error);
      }
      if (failure) states.set(id, { status: "error", error: failure });
      else states.delete(id);
      notify();
    },
  };
}

export function harnessInstallStore(diagnostics: RendererConnectionDiagnostics) {
  let store = stores.get(diagnostics);
  if (!store) {
    store = createStore(diagnostics);
    stores.set(diagnostics, store);
  }
  return store;
}

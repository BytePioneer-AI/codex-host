import { createHash } from "node:crypto";
import type {
  HarnessAdapter,
  HarnessInspection,
  HarnessResult,
  HarnessSession,
  InspectHarnessInput,
  OpenSessionInput,
} from "@codexhost/harness-adapter";
import { harnessInspectionSchema } from "@codexhost/shared-contracts";
import { CAPABILITIES, HARNESS_ID, PERMISSION_MODES } from "./configuration.js";
import { connect, inspectConnection, workspace } from "./connection.js";
import { errorOf, TraeError } from "./protocol.js";
import { TraeSession } from "./session.js";
import type { TraeOptions, TraeTransport } from "./transport.js";

export class TraeAdapter implements HarnessAdapter {
  readonly harnessId = HARNESS_ID;
  #closed = false;
  #sessions = new Set<TraeSession>();
  #transports = new Set<TraeTransport>();
  #catalogs = new Map<string, HarnessInspection>();
  #inflight = new Map<string, Promise<HarnessInspection>>();
  constructor(readonly options: TraeOptions = {}) {}

  #environment(input?: Record<string, string | undefined>): NodeJS.ProcessEnv {
    return { ...process.env, ...this.options.environment, ...input };
  }
  async inspect(input: InspectHarnessInput = {}): Promise<HarnessInspection> {
    if (this.#closed)
      return {
        status: "error",
        error: { code: "invalidState", message: "Trae adapter is closed", retryable: false },
      };
    const environment = this.#environment();
    // The opaque key scopes credentials and configuration without retaining them in diagnostics.
    const key = createHash("sha256")
      .update(JSON.stringify([input.cwd ?? process.cwd(), Object.entries(environment).sort()]))
      .digest("hex");
    const cached = this.#catalogs.get(key);
    if (!input.refresh && cached) return structuredClone(cached);
    const inflight = this.#inflight.get(key);
    if (!input.refresh && inflight) return structuredClone(await inflight);
    const pending = this.#inspect(input.cwd ?? process.cwd(), environment);
    this.#inflight.set(key, pending);
    try {
      const result = await pending;
      if (this.#inflight.get(key) === pending) {
        if (!this.#closed && result.status === "ready") this.#catalogs.set(key, result);
        else this.#catalogs.delete(key);
      }
      return structuredClone(result);
    } finally {
      if (this.#inflight.get(key) === pending) this.#inflight.delete(key);
    }
  }
  async #inspect(cwd: string, environment: NodeJS.ProcessEnv): Promise<HarnessInspection> {
    let transport: TraeTransport | undefined;
    try {
      if (this.#closed) throw new TraeError("invalidState", "Trae adapter is closed");
      cwd = await workspace(cwd);
      if (this.#closed) throw new TraeError("invalidState", "Trae adapter is closed");
      transport = connect(cwd, environment, this.options);
      this.#transports.add(transport);
      const catalog = await inspectConnection(transport);
      return harnessInspectionSchema.parse({
        status: "ready",
        catalog,
        permissionModes: PERMISSION_MODES,
        capabilities: CAPABILITIES,
      });
    } catch (error) {
      const e = errorOf(error);
      return {
        status:
          e.code === "notInstalled"
            ? "notInstalled"
            : e.code === "authenticationRequired" || e.code === "configurationRequired"
              ? "unavailable"
              : "error",
        error: e,
      };
    } finally {
      if (transport) {
        await transport.close();
        this.#transports.delete(transport);
      }
    }
  }
  async open(input: OpenSessionInput): Promise<HarnessResult<HarnessSession>> {
    let transport: TraeTransport | undefined;
    try {
      if (this.#closed) throw new TraeError("invalidState", "Trae adapter is closed");
      const cwd = await workspace(input.cwd);
      if (!["create", "resume", "fork", "rollbackLastTurn"].includes(input.kind))
        throw new TraeError("unsupported", "Unsupported Trae open operation");
      if (this.#closed) throw new TraeError("invalidState", "Trae adapter is closed");
      transport = connect(cwd, this.#environment(input.environment), this.options);
      this.#transports.add(transport);
      const catalog = await inspectConnection(transport);
      const session = await TraeSession.open(
        transport,
        { ...input, cwd },
        catalog,
        (closedSession) => this.#sessions.delete(closedSession),
      );
      if (this.#closed) {
        await session.close();
        throw new TraeError("invalidState", "Trae adapter closed during open");
      }
      this.#sessions.add(session);
      this.#transports.delete(transport);
      return { ok: true, value: session };
    } catch (error) {
      this.#catalogs.clear();
      if (transport) {
        await transport.close();
        this.#transports.delete(transport);
      }
      return { ok: false, error: errorOf(error) };
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#catalogs.clear();
    await Promise.all(
      [...this.#transports].map((t) => t.close()).concat([...this.#sessions].map((s) => s.close())),
    );
    this.#transports.clear();
    this.#sessions.clear();
  }
}

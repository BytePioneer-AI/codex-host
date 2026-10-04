import type { HarnessOutput } from "@codexhost/harness-adapter";
import type { ExternalThread } from "./external-thread-runtime.js";

/** A broken output consumer must neither leave the Turn running nor reuse its Session. */
export async function settleExternalOutputFailure(
  thread: ExternalThread,
  error: unknown,
  project: (output: HarnessOutput) => Promise<void>,
  diagnose: (error: unknown) => void,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  thread.stateObserver.fault(new Error(message));
  // Stop native work before allowing the Host Turn to leave its running state.
  // Outputs emitted by close belong to the broken stream and are not projected.
  try {
    await thread.session.close();
  } catch (closeError) {
    diagnose(closeError);
  }
  try {
    for (const { projector } of [...thread.projectedTurns.values()]) {
      for (const event of projector.failureEvents({
        code: "protocolError",
        message: `External Harness output failed: ${message}`,
        retryable: false,
      })) {
        await project({ kind: "event", event });
      }
    }
  } catch (projectionError) {
    // A disconnected Desktop may also reject the failure notification.
    diagnose(projectionError);
  }
}

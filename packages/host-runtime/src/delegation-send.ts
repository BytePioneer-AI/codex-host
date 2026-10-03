import { setTimeout as delay } from "node:timers/promises";
import { DelegationControlError } from "./delegation-types.js";

/** Retry only THREAD_BUSY: the Host guarantees this rejection precedes delivery. */
export async function sendWhenIdle<T>(input: {
  send(): Promise<T>;
  wait(timeoutMs: number): Promise<unknown>;
  timeoutMs: number;
}): Promise<T> {
  const deadline = Date.now() + input.timeoutMs;
  for (;;) {
    try {
      return await input.send();
    } catch (error) {
      if (
        !(error instanceof DelegationControlError) ||
        error.code !== "THREAD_BUSY" ||
        !input.timeoutMs
      )
        throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new DelegationControlError(
          "THREAD_BUSY",
          "Timed out waiting for the Thread; message was not delivered",
          { notDelivered: true },
        );
      }
      try {
        await input.wait(Math.min(remaining, 30_000));
      } catch (error) {
        // No send was accepted: an aborted idle read can safely report non-delivery.
        if (Date.now() >= deadline) {
          throw new DelegationControlError(
            "THREAD_BUSY",
            "Timed out waiting for the Thread; message was not delivered",
            { notDelivered: true },
          );
        }
        throw error;
      }
      // A terminal read can race with another sender or Host admission. Avoid a hot retry loop.
      const afterWait = deadline - Date.now();
      if (afterWait <= 0) {
        throw new DelegationControlError(
          "THREAD_BUSY",
          "Timed out waiting for the Thread; message was not delivered",
          { notDelivered: true },
        );
      }
      await delay(Math.min(50, afterWait));
      if (Date.now() >= deadline) {
        throw new DelegationControlError(
          "THREAD_BUSY",
          "Timed out waiting for the Thread; message was not delivered",
          { notDelivered: true },
        );
      }
    }
  }
}

import { vi } from "vitest";

/**
 * Vitest hardcodes `vi.waitFor`'s poll budget at 1000ms and exposes no config
 * for it (`const { interval = 50, timeout = 1e3 } = options`). That budget
 * assumes a developer machine; on a shared CI runner a render, an ESM import,
 * or a native module load can exceed it. The poll then rejects with whatever
 * the last attempt observed, so the report is an ordinary assertion diff that
 * reads like a logic bug instead of a timeout.
 *
 * Raising the default here keeps every call site declaring its intent
 * (`vi.waitFor(() => expect(...))`) instead of repeating a magic timeout, and
 * mirrors the `testTimeout` policy in `tests/vitest.config.js`.
 */
const DEFAULT_WAIT_FOR_TIMEOUT_MS = process.env.CI ? 15_000 : 1_000;

const waitFor: typeof vi.waitFor = vi.waitFor;

vi.waitFor = (callback, options) =>
  waitFor(callback, {
    timeout: DEFAULT_WAIT_FOR_TIMEOUT_MS,
    ...(typeof options === "number" ? { timeout: options } : options),
  });

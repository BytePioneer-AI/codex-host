import {
  DEFAULT_THREAD_LIST_LIMIT,
  DEFAULT_THREAD_LIST_SORT,
  DEFAULT_WAIT_TIMEOUT_MS,
  DEFAULT_WATCH_TIMEOUT_MS,
  DelegationControlError,
  THREAD_LIST_SORTS,
} from "./delegation-types.js";

type Body = Record<string, unknown>;

function withDefaults(body: Body, defaults: Body): Body {
  const missing = Object.entries(defaults).filter(([key]) => body[key] === undefined);
  return missing.length === 0 ? body : { ...body, ...Object.fromEntries(missing) };
}

/** `harness` is the documented name; `harnessId` is what the CLI sends and the Host uses. */
function withHarnessId(body: Body): Body {
  const { harness, ...rest } = body;
  if (harness !== undefined && rest.harnessId !== undefined && harness !== rest.harnessId)
    throw new DelegationControlError("INVALID_ARGUMENT", "harness and harnessId must be the same");
  const harnessId = rest.harnessId ?? harness;
  if (typeof harnessId !== "string" || !harnessId.trim())
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "harness must be a non-empty Harness identifier (harnessId is accepted as an alias)",
    );
  return { ...rest, harnessId };
}

/**
 * Fills the optional request fields with the CLI's defaults, so every transport
 * behaves like `codexhost` when a caller omits them.
 */
export function withDelegationRequestDefaults(route: string | undefined, body: Body): Body {
  switch (route) {
    case "/v1/delegate/start":
      return withHarnessId(body);
    case "/v1/thread/read":
      return withDefaults(body, { view: "result" });
    case "/v1/thread/wait":
      return withDefaults(body, { view: "result", timeoutMs: DEFAULT_WAIT_TIMEOUT_MS });
    case "/v1/thread/watch":
      return withDefaults(body, { timeoutMs: DEFAULT_WATCH_TIMEOUT_MS });
    case "/v1/thread/list": {
      const listed = withDefaults(body, {
        limit: DEFAULT_THREAD_LIST_LIMIT,
        sort: DEFAULT_THREAD_LIST_SORT,
      });
      if (!(THREAD_LIST_SORTS as readonly unknown[]).includes(listed.sort))
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          `sort must be one of ${THREAD_LIST_SORTS.join(", ")}`,
        );
      return listed;
    }
    default:
      return body;
  }
}

import { createServer, type RequestListener } from "node:http";

// Allow minute-scale browser idle reuse (Chrome/Safari may evict sooner), while
// bounding how long an unused connection occupies a relay slot.
export const HTTP_KEEP_ALIVE_TIMEOUT = 120_000;

export function createWebServer(listener: RequestListener) {
  return createServer({ keepAliveTimeout: HTTP_KEEP_ALIVE_TIMEOUT }, listener);
}

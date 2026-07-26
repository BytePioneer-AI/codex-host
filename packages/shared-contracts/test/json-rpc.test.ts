import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  jsonRpcEnvelopeSchema,
  jsonRpcErrorResponseSchema,
  jsonRpcNotificationSchema,
  jsonRpcRequestSchema,
  jsonRpcSuccessResponseSchema,
} from "../src/index.js";
import type { JsonRpcNotification, JsonRpcRequest } from "../src/index.js";

interface GateAAppServerFixture {
  requests: unknown[];
  responseShapes: unknown[];
}

const fixturePath = resolve(
  import.meta.dirname,
  "../../../tests/fixtures/gate-a/windows/official-app-server.fixture.json",
);
const gateAFixture = JSON.parse(readFileSync(fixturePath, "utf8")) as GateAAppServerFixture;

function hasOwn(value: unknown, key: string): boolean {
  return typeof value === "object" && value !== null && Object.hasOwn(value, key);
}

function assertExactEnvelopeFields(
  notification: JsonRpcNotification,
  request: JsonRpcRequest,
): void {
  // @ts-expect-error A Notification ID must be absent, not undefined.
  const invalidNotification: JsonRpcNotification = { ...notification, id: undefined };
  // @ts-expect-error A Request result must be absent, not undefined.
  const invalidRequest: JsonRpcRequest = { ...request, result: undefined };

  void invalidNotification;
  void invalidRequest;
}

void assertExactEnvelopeFields;

describe("Codex-compatible JSON-RPC envelope contracts", () => {
  it("parses every reviewed Gate A envelope without requiring jsonrpc", () => {
    for (const value of gateAFixture.requests) {
      const parsed = hasOwn(value, "id")
        ? jsonRpcRequestSchema.parse(value)
        : jsonRpcNotificationSchema.parse(value);
      expect(parsed).not.toHaveProperty("jsonrpc");
      expect(jsonRpcEnvelopeSchema.parse(value)).toEqual(value);
    }

    for (const value of gateAFixture.responseShapes) {
      const parsed = hasOwn(value, "result")
        ? jsonRpcSuccessResponseSchema.parse(value)
        : jsonRpcErrorResponseSchema.parse(value);
      expect(parsed).not.toHaveProperty("jsonrpc");
      expect(jsonRpcEnvelopeSchema.parse(value)).toEqual(value);
    }
  });

  it("uses one request shape for both protocol directions and ID forms", () => {
    const desktopRequest = {
      jsonrpc: "2.0",
      id: 7,
      method: "desktop/request",
      params: { source: "desktop" },
    };
    const serverRequest = {
      id: "server-request-1",
      method: "server/request",
      params: ["opaque", 1],
    };

    expect(jsonRpcRequestSchema.parse(desktopRequest)).toEqual(desktopRequest);
    expect(jsonRpcRequestSchema.parse(serverRequest)).toEqual(serverRequest);
  });

  it("accepts unknown methods and preserves envelope and error extensions", () => {
    const request = {
      id: "opaque-id",
      method: "codexhost/future-method",
      params: { supported: true },
      traceContext: { sequence: 3 },
    };
    const errorResponse = {
      id: 9,
      error: {
        code: -32_600,
        message: "synthetic failure",
        category: "future-category",
      },
      transportExtension: false,
    };

    expect(jsonRpcRequestSchema.parse(request)).toEqual(request);
    expect(jsonRpcErrorResponseSchema.parse(errorResponse)).toEqual(errorResponse);
  });

  it("rejects non-JSON envelope and error extension values", () => {
    const cyclicExtension: Record<string, unknown> = {};
    cyclicExtension.self = cyclicExtension;
    const requests = [
      { id: 1, method: "bigint-extension", future: 1n },
      { id: 2, method: "function-extension", future: () => 1 },
      { id: 3, method: "cyclic-extension", future: cyclicExtension },
    ];
    const errorResponses = [
      { id: 4, error: { code: -1, message: "bigint extension", future: 1n } },
      { id: 5, error: { code: -1, message: "function extension", future: () => 1 } },
      { id: 6, error: { code: -1, message: "cyclic extension", future: cyclicExtension } },
    ];

    for (const request of requests) {
      expect(jsonRpcRequestSchema.safeParse(request).success).toBe(false);
      expect(jsonRpcEnvelopeSchema.safeParse(request).success).toBe(false);
    }
    for (const response of errorResponses) {
      expect(jsonRpcErrorResponseSchema.safeParse(response).success).toBe(false);
      expect(jsonRpcEnvelopeSchema.safeParse(response).success).toBe(false);
    }
  });

  it("preserves JSON round-trips for every envelope kind", () => {
    const envelopes = [
      { id: 1, method: "request", params: null },
      { method: "notification", params: {} },
      { id: "success", result: { values: [1, true, null] } },
      { id: "failure", error: { code: -1, message: "failed", data: { retry: false } } },
    ];

    for (const envelope of envelopes) {
      const parsed = jsonRpcEnvelopeSchema.parse(envelope);
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
    }
  });

  it("rejects explicit undefined in optional and forbidden fields", () => {
    const values = [
      { method: "notification", id: undefined },
      { id: 1, method: "request", result: undefined },
      { id: 2, method: "request", params: undefined },
      { id: 3, result: null, error: undefined },
      { id: 4, error: { code: -1, message: "failed", data: undefined } },
    ];

    expect(jsonRpcNotificationSchema.safeParse(values[0]).success).toBe(false);
    expect(jsonRpcRequestSchema.safeParse(values[1]).success).toBe(false);
    expect(jsonRpcRequestSchema.safeParse(values[2]).success).toBe(false);
    expect(jsonRpcSuccessResponseSchema.safeParse(values[3]).success).toBe(false);
    expect(jsonRpcErrorResponseSchema.safeParse(values[4]).success).toBe(false);
    for (const value of values) {
      expect(jsonRpcEnvelopeSchema.safeParse(value).success).toBe(false);
    }
  });

  it.each([
    { id: 1, result: {}, error: { code: -1, message: "conflict" } },
    { id: 1, method: "response-cannot-have-method", result: {} },
    { id: null, method: "null-id" },
    { id: null, result: {} },
    { id: 1, error: { message: "missing code" } },
    { id: 1, error: { code: -1 } },
    { id: 1, error: { code: -1.5, message: "fractional code" } },
    { jsonrpc: "1.0", id: 1, method: "wrong-version" },
  ])("rejects conflicting or malformed envelope %#", (value) => {
    expect(jsonRpcEnvelopeSchema.safeParse(value).success).toBe(false);
  });

  it("rejects an ID on the notification-specific schema", () => {
    expect(
      jsonRpcNotificationSchema.safeParse({ id: 1, method: "not-a-notification" }).success,
    ).toBe(false);
  });
});

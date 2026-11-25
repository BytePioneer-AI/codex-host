import * as acme from "acme-client";
import { afterEach, expect, it } from "vitest";
import "../src/certificates.js";

const adapter = acme.axios.defaults.adapter;
afterEach(() => {
  if (adapter === undefined) delete acme.axios.defaults.adapter;
  else acme.axios.defaults.adapter = adapter;
});

it("allows slower dual-stack connections without disabling IPv6", () => {
  expect(acme.axios.defaults.httpsAgent.options).toMatchObject({
    keepAlive: true,
    autoSelectFamilyAttemptTimeout: 2_000,
  });
  expect(acme.axios.defaults.httpsAgent.options.family).toBeUndefined();
  expect(acme.axios.defaults.timeout).toBe(30_000);
});

it.each(["ETIMEDOUT", "ENETUNREACH", "ECONNRESET", "ECONNABORTED"])(
  "preserves the original %s failure when there is no HTTP response",
  async (code) => {
    const original = Object.assign(new Error(`Transport failed: ${code}`), { code });
    let attempts = 0;
    acme.axios.defaults.adapter = async (config) => {
      attempts++;
      throw Object.assign(original, { config });
    };
    await expect(acme.axios.get("https://acme.invalid/directory")).rejects.toBe(original);
    expect(attempts).toBe(1);
  },
);

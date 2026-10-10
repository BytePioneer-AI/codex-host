import { describe, expect, it } from "vitest";

import { allowedChange, allowedHost } from "../src/request-guard.js";

describe("console request guard", () => {
  it("accepts only the console's own loopback authority", () => {
    expect(allowedHost("127.0.0.1:4399", 4399)).toBe(true);
    expect(allowedHost("localhost:4399", 4399)).toBe(true);
    expect(allowedHost("attacker.example:4399", 4399)).toBe(false);
    expect(allowedHost("127.0.0.1:1", 4399)).toBe(false);
    expect(allowedHost(undefined, 4399)).toBe(false);
  });

  it("accepts changes only from the console page or a local tool", () => {
    expect(allowedChange("http://127.0.0.1:4399", "1", 4399)).toBe(true);
    expect(allowedChange("http://localhost:4399", "1", 4399)).toBe(true);
    expect(allowedChange(undefined, "1", 4399)).toBe(true);
    expect(allowedChange("http://127.0.0.1:4399", undefined, 4399)).toBe(false);
    expect(allowedChange("https://attacker.example", "1", 4399)).toBe(false);
    expect(allowedChange("http://127.0.0.1:1", "1", 4399)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { allowedChange, allowedHost } from "../src/request-guard.js";

describe("console request guard", () => {
  it("accepts only the console's own loopback authority", () => {
    expect(allowedHost("127.0.0.1:26339", 26339)).toBe(true);
    expect(allowedHost("localhost:26339", 26339)).toBe(true);
    expect(allowedHost("attacker.example:26339", 26339)).toBe(false);
    expect(allowedHost("127.0.0.1:1", 26339)).toBe(false);
    expect(allowedHost(undefined, 26339)).toBe(false);
  });

  it("accepts changes only from the console page or a local tool", () => {
    expect(allowedChange("http://127.0.0.1:26339", "1", 26339)).toBe(true);
    expect(allowedChange("http://localhost:26339", "1", 26339)).toBe(true);
    expect(allowedChange(undefined, "1", 26339)).toBe(true);
    expect(allowedChange("http://127.0.0.1:26339", undefined, 26339)).toBe(false);
    expect(allowedChange("https://attacker.example", "1", 26339)).toBe(false);
    expect(allowedChange("http://127.0.0.1:1", "1", 26339)).toBe(false);
  });
});

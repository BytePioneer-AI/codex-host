import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { codeBuddyAcpOutput } from "../src/acp-stdio.js";

describe("native ACP server stdout", () => {
  it("filters banners and passwords across chunk boundaries, preserving ACP frames and the endpoint", async () => {
    const frames = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "连接正常" } }),
      JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {} }),
    ];
    const text = `\nCodeBuddy HTTP Server\n  Endpoint    http://127.0.0.1:12345\n  Password    never-forward-this\n${frames[0]}\n${frames[1]}\n`;
    const bytes = Buffer.from(text);
    const source = Readable.from(
      Array.from({ length: bytes.length }, (_, i) => bytes.subarray(i, i + 1)),
    );
    let endpoint;
    let output = "";
    for await (const data of codeBuddyAcpOutput(source, (line) => {
      if (line.includes("Endpoint")) endpoint = line.trim();
    }))
      output += data;
    expect(output).toBe(`${frames.join("\n")}\n`);
    expect(output).not.toContain("never-forward-this");
    expect(endpoint).toBe("Endpoint    http://127.0.0.1:12345");
  });
});

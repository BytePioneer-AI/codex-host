import { afterEach, describe, expect, it, vi } from "vitest";
import * as runtime from "../src/hermes-runtime.js";
import { readHermesSessions } from "../src/gateway-session-list.js";

const options = { runtime: "/native/python", cwd: process.cwd(), environment: {}, timeoutMs: 2000 };
function command(script: string) {
  return vi
    .spyOn(runtime, "hermesPythonCommand")
    .mockResolvedValue({ command: process.execPath, arguments: ["-e", script] });
}
afterEach(() => vi.restoreAllMocks());

describe("Hermes native metadata subprocess", () => {
  it("sends only the selected identity and validates the metadata envelope", async () => {
    const launch =
      command(`let input = ''; process.stdin.on('data', d => input += d); process.stdin.on('end', () => {
      const p = JSON.parse(input); process.stdout.write(JSON.stringify({sessions: [{id: p.nativeSessionId}]}));
    });`);
    expect(await readHermesSessions({ ...options, nativeSessionId: "selected" })).toEqual([
      { id: "selected" },
    ]);
    const script = launch.mock.calls[0]?.[1];
    expect(script).toContain("SessionDB(read_only=True)");
    expect(script).toContain("limit=-1");
    expect(script).not.toContain("session.resume");
  });
  it.each(["not-json", "{}", '{"sessions":null}'])(
    "rejects malformed output %s",
    async (output) => {
      command(`process.stdout.write(${JSON.stringify(output)});`);
      await expect(readHermesSessions(options)).rejects.toThrow(
        "Malformed Hermes native session listing",
      );
    },
  );
  it("does not expose native stderr or command contents on failure", async () => {
    command("process.stderr.write('private-transcript-credential'); process.exit(1);");
    await expect(readHermesSessions(options)).rejects.toThrow(
      "Cannot read Hermes native session metadata; source history was not modified",
    );
  });
  it("terminates a stalled subprocess on timeout", async () => {
    command("setInterval(() => {}, 1000);");
    await expect(readHermesSessions({ ...options, timeoutMs: 50 })).rejects.toThrow(
      "Cannot read Hermes native session metadata",
    );
  });
  it("cancels a stalled subprocess with the caller's AbortSignal", async () => {
    command("setInterval(() => {}, 1000);");
    const controller = new AbortController();
    const pending = readHermesSessions({ ...options, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

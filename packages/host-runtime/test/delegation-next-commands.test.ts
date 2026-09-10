import { describe, expect, it } from "vitest";

import { delegationNextCommands } from "../src/delegation-types.js";

const thread = "thread-1";

function read(cliPath: string | undefined, platform: NodeJS.Platform): string {
  return delegationNextCommands(
    cliPath === undefined ? {} : { CODEXHOST_CLI_PATH: cliPath },
    thread,
    platform,
  ).read;
}

describe("delegationNextCommands", () => {
  it("leaves ordinary install paths unquoted so any target shell can run them", () => {
    expect(read("/Applications/codexhost.app/Contents/MacOS/codexhost", "darwin")).toBe(
      `/Applications/codexhost.app/Contents/MacOS/codexhost thread read ${thread}`,
    );
    expect(read(String.raw`C:\Users\dev\codexhost\codexhost.exe`, "win32")).toBe(
      String.raw`C:\Users\dev\codexhost\codexhost.exe thread read ${thread}`,
    );
  });

  it("quotes a POSIX path containing spaces literally", () => {
    expect(read("/Applications/My codexhost.app/Contents/MacOS/codexhost", "darwin")).toBe(
      `'/Applications/My codexhost.app/Contents/MacOS/codexhost' thread read ${thread}`,
    );
  });

  it("keeps Windows backslashes literal and calls through the PowerShell operator", () => {
    // A leading quoted string is only an expression in PowerShell, so `&` is
    // required; backslashes must survive verbatim rather than being escaped as
    // they would be in a C or JSON string literal.
    const command = read(String.raw`C:\Program Files\codexhost\codexhost.exe`, "win32");
    expect(command).toBe(
      String.raw`& 'C:\Program Files\codexhost\codexhost.exe' thread read ${thread}`,
    );
    expect(command).not.toContain(String.raw`\\`);
  });

  it("escapes single quotes for each shell", () => {
    expect(read("/opt/it's/codexhost", "linux")).toBe(
      `'/opt/it'\\''s/codexhost' thread read ${thread}`,
    );
    expect(read(String.raw`C:\it's dir\codexhost.exe`, "win32")).toBe(
      String.raw`& 'C:\it''s dir\codexhost.exe' thread read ${thread}`,
    );
  });

  it("falls back to the bare name only when the Host provided no path", () => {
    expect(read(undefined, "darwin")).toBe(`codexhost thread read ${thread}`);
    expect(delegationNextCommands({}, thread, "darwin").wait).toBe(
      `codexhost thread wait ${thread} --timeout-ms 30000`,
    );
  });
});

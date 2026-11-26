import { describe, expect, it } from "vitest";

import { VERSION_MANAGER_ROOTS } from "@codexhost/harness-discovery";

import { OMO_COMMAND_ENV, omoDiscoverySpec, resolveOmoExecutable } from "../src/command.js";

describe("OmO executable discovery", () => {
  it("declares omo's command, override variable and install roots", () => {
    expect(omoDiscoverySpec).toEqual({
      id: "omo",
      command: "omo",
      commandEnvironmentVariable: "CODEXHOST_OMO_COMMAND",
      installRoots: {
        posix: [
          "~/.local/bin",
          "~/.bun/bin",
          "/opt/homebrew/bin",
          "/usr/local/bin",
          VERSION_MANAGER_ROOTS,
        ],
        windows: ["~/.local/bin", "~/.bun/bin", "${APPDATA}/npm", VERSION_MANAGER_ROOTS],
      },
    });
    expect(OMO_COMMAND_ENV).toBe("CODEXHOST_OMO_COMMAND");
    // Guard against copying Pi's discovery facts into the OmO plugin.
    expect(JSON.stringify(omoDiscoverySpec)).not.toContain("PI_COMMAND");
  });

  it("uses an explicitly configured installation without falling back", () => {
    expect(
      resolveOmoExecutable(
        { environment: { PATH: "/usr/bin", CODEXHOST_OMO_COMMAND: "/chosen/omo" } },
        {
          platform: "linux",
          homeDirectory: "/home/test",
          isExecutable: (file) => file === "/chosen/omo",
          subdirectories: () => [],
        },
      ),
    ).toBe("/chosen/omo");

    expect(
      resolveOmoExecutable(
        { environment: { PATH: "/usr/bin", CODEXHOST_OMO_COMMAND: "/chosen/omo" } },
        {
          platform: "linux",
          homeDirectory: "/home/test",
          isExecutable: (file) => file === "/usr/bin/omo",
          subdirectories: () => [],
        },
      ),
    ).toBeUndefined();
  });

  it("searches the declared POSIX install roots after PATH", () => {
    expect(
      resolveOmoExecutable(
        { environment: { PATH: "/empty" } },
        {
          platform: "linux",
          homeDirectory: "/home/test",
          isExecutable: (file) => file === "/home/test/.bun/bin/omo",
          subdirectories: () => [],
        },
      ),
    ).toBe("/home/test/.bun/bin/omo");
  });

  it("searches the APPDATA npm root on Windows", () => {
    expect(
      resolveOmoExecutable(
        { environment: { PATH: "", APPDATA: "C:\\Users\\test\\AppData\\Roaming" } },
        {
          platform: "win32",
          homeDirectory: "C:\\Users\\test",
          isExecutable: (file) => file === "C:\\Users\\test\\AppData\\Roaming\\npm\\omo.exe",
          subdirectories: () => [],
        },
      ),
    ).toBe("C:\\Users\\test\\AppData\\Roaming\\npm\\omo.exe");
  });

  it("includes Node.js version-manager binary roots", () => {
    const directories: string[] = [];
    expect(
      resolveOmoExecutable(
        { environment: { PATH: "", NVM_DIR: "/custom/nvm" } },
        {
          platform: "linux",
          homeDirectory: "/home/test",
          isExecutable: (file) => file === "/custom/nvm/versions/node/v24.1.0/bin/omo",
          subdirectories: (directory) => {
            directories.push(directory);
            return directory === "/custom/nvm/versions/node" ? ["v24.1.0"] : [];
          },
        },
      ),
    ).toBe("/custom/nvm/versions/node/v24.1.0/bin/omo");
    expect(directories).toContain("/custom/nvm/versions/node");
  });

  it("never resolves a configured path that is not executable", () => {
    expect(
      resolveOmoExecutable(
        {
          environment: {
            PATH: "/usr/bin",
            CODEXHOST_OMO_COMMAND: 'C:\\missing dir\\om "o"\\omo.exe',
          },
        },
        {
          platform: "win32",
          homeDirectory: "C:\\Users\\test",
          isExecutable: () => false,
          subdirectories: () => [],
        },
      ),
    ).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";

import {
  commandInvocation,
  harnessCandidates,
  resolveHarnessExecutable,
  versionManagerBinaryDirectories,
  withNodeRuntimeOnPath,
  VERSION_MANAGER_ROOTS,
  type HarnessDiscoverySpec,
} from "../src/index.js";

const spec: HarnessDiscoverySpec = {
  id: "demo",
  command: "demo",
  commandEnvironmentVariable: "DEMO_COMMAND",
  installRoots: {
    posix: ["~/.npm-global/bin", VERSION_MANAGER_ROOTS, "/opt/homebrew/bin"],
    windows: ["${APPDATA}/npm", VERSION_MANAGER_ROOTS],
  },
};

const HOME = "/home/user";
const NVM = `${HOME}/.nvm/versions/node`;

function only(...executables: string[]) {
  return { isExecutable: (candidate: string) => executables.includes(candidate) };
}

function nodeVersions(...versions: string[]) {
  return {
    subdirectories: (directory: string) => (directory === NVM ? [...versions] : []),
  };
}

describe("harness discovery", () => {
  it("resolves from PATH before any install root", () => {
    const resolution = resolveHarnessExecutable(
      spec,
      { environment: { PATH: "/usr/bin:/opt/bin" }, homeDirectory: HOME, platform: "linux" },
      only("/opt/bin/demo", "/opt/homebrew/bin/demo"),
    );
    expect(resolution).toEqual({ executable: "/opt/bin/demo", source: "path" });
  });

  it("finds a harness installed under a Node.js version that is not active", () => {
    // codexhost runs on v22 and only has v22 on PATH; the harness lives on v24.
    const resolution = resolveHarnessExecutable(
      spec,
      {
        environment: { PATH: `${NVM}/v22.22.0/bin` },
        homeDirectory: HOME,
        platform: "linux",
      },
      { ...only(`${NVM}/v24.18.0/bin/demo`), ...nodeVersions("v22.22.0", "v24.18.0") },
    );
    expect(resolution).toEqual({
      executable: `${NVM}/v24.18.0/bin/demo`,
      source: "install-root",
    });
  });

  it("prefers the newest runtime when several carry the harness", () => {
    const resolution = resolveHarnessExecutable(
      spec,
      { environment: { PATH: "" }, homeDirectory: HOME, platform: "linux" },
      {
        isExecutable: (candidate) => candidate.startsWith(NVM),
        ...nodeVersions("v9.1.0", "v22.22.0", "v24.18.0"),
      },
    );
    // Numeric-aware ordering: v24 wins over v22, and v9 does not win over v22.
    expect(resolution?.executable).toBe(`${NVM}/v24.18.0/bin/demo`);
  });

  it("honours a relocated NVM_DIR", () => {
    const relocated = "/opt/nvm/versions/node";
    const resolution = resolveHarnessExecutable(
      spec,
      {
        environment: { PATH: "", NVM_DIR: "/opt/nvm" },
        homeDirectory: HOME,
        platform: "linux",
      },
      {
        ...only(`${relocated}/v24.18.0/bin/demo`),
        subdirectories: (directory) => (directory === relocated ? ["v24.18.0"] : []),
      },
    );
    expect(resolution?.executable).toBe(`${relocated}/v24.18.0/bin/demo`);
  });

  it("does not fall back to install roots for a configured command", () => {
    // A configured command names one installation; resolving to a different
    // one elsewhere on the machine would silently ignore the user's choice.
    expect(
      resolveHarnessExecutable(
        spec,
        { environment: { PATH: "", DEMO_COMMAND: "demo" }, homeDirectory: HOME, platform: "linux" },
        only("/opt/homebrew/bin/demo"),
      ),
    ).toBeUndefined();
  });

  it("expands ~ and ${VARIABLE} install roots per platform", () => {
    expect(
      harnessCandidates(
        spec,
        {
          environment: { PATH: "", APPDATA: String.raw`C:\Users\u\AppData\Roaming` },
          homeDirectory: String.raw`C:\Users\u`,
          platform: "win32",
        },
        { subdirectories: () => [] },
      ).map(({ candidate }) => candidate),
    ).toContain(String.raw`C:\Users\u\AppData\Roaming\npm\demo.cmd`);

    const posix = harnessCandidates(
      spec,
      { environment: { PATH: "" }, homeDirectory: HOME, platform: "linux" },
      { subdirectories: () => [] },
    ).map(({ candidate }) => candidate);
    // Declared order is preserved around the expanded version-manager block.
    expect(posix.at(0)).toBe(`${HOME}/.npm-global/bin/demo`);
    expect(posix.at(-1)).toBe("/opt/homebrew/bin/demo");
  });

  it("applies PATHEXT only on Windows", () => {
    const candidates = harnessCandidates(
      spec,
      { environment: { PATH: String.raw`C:\bin`, PATHEXT: ".EXE;.CMD" }, platform: "win32" },
      { subdirectories: () => [] },
    ).filter(({ source }) => source === "path");
    expect(candidates.map(({ candidate }) => candidate)).toEqual([
      String.raw`C:\bin\demo.EXE`,
      String.raw`C:\bin\demo.CMD`,
    ]);
  });

  it("lets a spec rewrite or reject a matched candidate", () => {
    const rewriting: HarnessDiscoverySpec = {
      ...spec,
      runnableCandidate: (candidate, { isExecutable }) => {
        if (!candidate.endsWith(".shim")) return candidate;
        const native = candidate.replace(/\.shim$/u, ".native");
        return isExecutable(native) ? native : undefined;
      },
    };
    expect(
      resolveHarnessExecutable(
        rewriting,
        { environment: { PATH: "/opt/bin" }, platform: "linux", homeDirectory: HOME },
        only("/opt/bin/demo"),
      )?.executable,
    ).toBe("/opt/bin/demo");
  });

  it("covers the version managers that PATH alone cannot reach", () => {
    const directories = versionManagerBinaryDirectories({
      platform: "linux",
      environment: {},
      home: HOME,
      subdirectories: (directory) =>
        directory.endsWith("node-versions") || directory.endsWith("nodejs") ? ["24.0.0"] : [],
    });
    expect(directories).toEqual(
      expect.arrayContaining([
        `${HOME}/.local/share/fnm/node-versions/24.0.0/installation/bin`,
        `${HOME}/.asdf/installs/nodejs/24.0.0/bin`,
        `${HOME}/.volta/bin`,
        `${HOME}/.bun/bin`,
      ]),
    );
  });
});

describe("command invocation", () => {
  it("wraps a Windows CMD shim in cmd.exe with verbatim arguments", () => {
    const invocation = commandInvocation(
      String.raw`C:\bin\demo.CMD`,
      ["--mode", "rpc"],
      { ComSpec: String.raw`C:\Windows\System32\cmd.exe` },
      "win32",
    );
    expect(invocation.command).toBe(String.raw`C:\Windows\System32\cmd.exe`);
    expect(invocation.arguments.slice(0, 4)).toEqual(["/d", "/v:off", "/s", "/c"]);
    expect(invocation.arguments.at(-1)).toContain(String.raw`"C:\bin\demo.CMD" "--mode" "rpc"`);
    expect(invocation.windowsVerbatimArguments).toBe(true);
  });

  it("spawns a native executable directly", () => {
    const invocation = commandInvocation("/opt/bin/demo", ["--mode", "rpc"], {}, "linux");
    expect(invocation).toEqual({
      command: "/opt/bin/demo",
      arguments: ["--mode", "rpc"],
      windowsVerbatimArguments: false,
    });
  });
});

describe("node runtime on PATH", () => {
  it("prepends the host runtime directory once", () => {
    const environment = withNodeRuntimeOnPath({ PATH: "/usr/bin" }, "/opt/runtime/node", "linux");
    expect(environment.PATH).toBe("/opt/runtime:/usr/bin");
    expect(
      withNodeRuntimeOnPath({ PATH: "/opt/runtime:/usr/bin" }, "/opt/runtime/node", "linux").PATH,
    ).toBe("/opt/runtime:/usr/bin");
  });
});

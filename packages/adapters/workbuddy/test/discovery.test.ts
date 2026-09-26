import { describe, expect, it } from "vitest";
import { workBuddyInvocation } from "../src/command.js";
import {
  mapWindowsAcpToEncoding,
  parseUninstallRegistryOutput,
  parseWindowsDisplayIcon,
  parseWindowsShortcutTargetBuffer,
  selectPairedExecutablesFromHives,
} from "../src/discovery.js";

describe("WorkBuddy app discovery", () => {
  it.each(["WorkBuddy.exe", "WorkBuddy AI.exe", "WorkBuddyAI.exe"])(
    "finds %s inside a selected installation directory",
    (name) => {
      const directory = "D:\\自定义 WorkBuddy";
      const executable = `${directory}\\${name}`;
      const cli = `${directory}\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy`;
      const dependencies = {
        platform: "win32" as const,
        isDirectory: (candidate: string) => candidate === directory,
        isExecutable: (candidate: string) => candidate === executable || candidate === cli,
      };
      const invocation = workBuddyInvocation(
        { CODEXHOST_WORKBUDDY_COMMAND: directory },
        false,
        dependencies,
      );
      expect(invocation.command).toBe(executable);
      expect(invocation.arguments).toEqual([cli, "--acp"]);
      expect(invocation.environment.ELECTRON_RUN_AS_NODE).toBe("1");
      expect(() =>
        workBuddyInvocation({ CODEXHOST_WORKBUDDY_COMMAND: directory }, false, {
          ...dependencies,
          isExecutable: (candidate) => candidate !== cli,
        }),
      ).toThrow("unavailable");
    },
  );
  it.each([
    [
      "win32",
      "D:\\Custom Apps\\WorkBuddy.exe",
      "D:\\Custom Apps\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy",
    ],
    [
      "win32",
      "D:\\Custom Apps\\WorkBuddyAI.exe",
      "D:\\Custom Apps\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy",
    ],
    [
      "darwin",
      "/custom/WorkBuddy AI.app/Contents/MacOS/Electron",
      "/custom/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy",
    ],
  ] as const)(
    "pairs an explicit %s Desktop path with only its own CLI",
    (platform, executable, cli) => {
      const invocation = workBuddyInvocation({ CODEXHOST_WORKBUDDY_COMMAND: executable }, false, {
        platform,
        isExecutable: (file) => file === executable || file === cli,
      });
      expect(invocation.command).toBe(executable);
      expect(invocation.arguments).toEqual([cli, "--acp"]);
      expect(invocation.environment.ELECTRON_RUN_AS_NODE).toBe("1");
      expect(() =>
        workBuddyInvocation({ CODEXHOST_WORKBUDDY_COMMAND: executable }, false, {
          platform,
          isExecutable: (file) => file !== cli,
        }),
      ).toThrow("unavailable");
    },
  );
  it.each([
    ["C:\\Users\\Test\\AppData\\Local\\Programs\\WorkBuddy", "WorkBuddy.exe"],
    ["C:\\Users\\Test\\AppData\\Local\\Programs\\WorkBuddy AI", "WorkBuddy AI.exe"],
    ["C:\\Program Files\\WorkBuddy", "WorkBuddy.exe"],
    ["D:\\Portable WorkBuddy", "WorkBuddy.exe"],
    ["D:\\Portable WorkBuddy", "WorkBuddyAI.exe"],
  ])("finds a Windows app in %s", (root, name) => {
    const executable = `${root}\\${name}`;
    const cli = `${root}\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy`;
    const invocation = workBuddyInvocation(
      {
        USERPROFILE: "C:\\Users\\Test",
        LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
        ProgramFiles: "C:\\Program Files",
        PATH: "D:\\Portable WorkBuddy",
      },
      true,
      {
        platform: "win32",
        isExecutable: (candidate) =>
          [executable, cli].some((file) => file.toLowerCase() === candidate.toLowerCase()),
      },
    );
    expect(invocation.command.toLowerCase()).toBe(executable.toLowerCase());
    expect(invocation.arguments).toEqual([cli, "--acp", "--no-session-persistence"]);
    expect(invocation.environment).toMatchObject({
      ELECTRON_RUN_AS_NODE: "1",
      WORKBUDDY_CONFIG_DIR: "C:\\Users\\Test\\.workbuddy-ai",
      CODEBUDDY_CONFIG_DIR: "C:\\Users\\Test\\.workbuddy-ai",
    });
  });

  it.each([
    "/Applications/WorkBuddy.app",
    "/Users/test/Applications/WorkBuddy AI.app",
    "/Users/test/Applications/WorkBuddy.app",
  ])("finds the macOS bundle %s", (root) => {
    const executable = `${root}/Contents/MacOS/Electron`;
    const cli = `${root}/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy`;
    const invocation = workBuddyInvocation({ HOME: "/Users/test" }, false, {
      platform: "darwin",
      isExecutable: (candidate) => [executable, cli].includes(candidate),
    });
    expect(invocation.command).toBe(executable);
    expect(invocation.arguments).toEqual([cli, "--acp"]);
  });

  it("never combines an app executable with another installation's CLI", () => {
    const files = [
      "C:\\Users\\Test\\AppData\\Local\\Programs\\WorkBuddy AI\\WorkBuddy AI.exe",
      "C:\\Users\\Test\\AppData\\Local\\Programs\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy",
    ];
    expect(() =>
      workBuddyInvocation({ USERPROFILE: "C:\\Users\\Test" }, false, {
        platform: "win32",
        isExecutable: (candidate) => files.includes(candidate),
      }),
    ).toThrow("unavailable");
  });

  it("does not replace a missing explicit command with an installed app", () => {
    expect(() =>
      workBuddyInvocation(
        { USERPROFILE: "C:\\Users\\Test", CODEXHOST_WORKBUDDY_COMMAND: "C:\\missing.exe" },
        false,
        {
          platform: "win32",
          isExecutable: (candidate) => candidate !== "C:\\missing.exe",
        },
      ),
    ).toThrow("unavailable");
  });

  it("forwards the Windows product snapshot using Windows paths", () => {
    const root = "C:\\Users\\Test\\AppData\\Local\\Programs\\WorkBuddy";
    const config = "C:\\Users\\Test\\.workbuddy-ai";
    const cache = `${config}\\cache`;
    const snapshot = `${cache}\\acc-product-config-v3.json`;
    const invocation = workBuddyInvocation({ USERPROFILE: "C:\\Users\\Test" }, false, {
      platform: "win32",
      isExecutable: (candidate) =>
        [
          `${root}\\WorkBuddy.exe`,
          `${root}\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy`,
        ].includes(candidate),
      lstat: (candidate) => ({
        isDirectory: () => [config, cache].includes(candidate),
        isFile: () => candidate === snapshot,
        isSymbolicLink: () => false,
        mode: 0o666,
        size: 10,
        uid: 0,
      }),
    });
    expect(invocation.environment.ACC_PRODUCT_CONFIG_PATH).toBe(snapshot);
  });

  it("discovers a custom Windows install via DisplayIcon / Start Menu when app is not running", () => {
    const executable = "D:\\program\\WorkBuddy\\WorkBuddyAI\\WorkBuddyAI.exe";
    const cli =
      "D:\\program\\WorkBuddy\\WorkBuddyAI\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy";
    const invocation = workBuddyInvocation(
      {
        USERPROFILE: "C:\\Users\\Test",
        LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
        ProgramFiles: "C:\\Program Files",
      },
      false,
      {
        platform: "win32",
        isExecutable: (candidate) => candidate === executable || candidate === cli,
        windowsInstallExecutables: () => [executable],
      },
    );
    expect(invocation.command).toBe(executable);
    expect(invocation.arguments).toEqual([cli, "--acp"]);
    expect(invocation.environment.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("does not use install fallbacks when CODEXHOST_WORKBUDDY_COMMAND is set but missing", () => {
    const custom = "D:\\program\\WorkBuddy\\WorkBuddyAI\\WorkBuddyAI.exe";
    const cli =
      "D:\\program\\WorkBuddy\\WorkBuddyAI\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy";
    expect(() =>
      workBuddyInvocation(
        {
          USERPROFILE: "C:\\Users\\Test",
          CODEXHOST_WORKBUDDY_COMMAND: "C:\\missing.exe",
        },
        false,
        {
          platform: "win32",
          isExecutable: (candidate) => candidate === custom || candidate === cli,
          windowsInstallExecutables: () => [custom],
        },
      ),
    ).toThrow("unavailable");
  });
});

describe("Windows DisplayIcon / uninstall registry parsing", () => {
  it.each([
    [
      '"D:\\program\\WorkBuddy\\WorkBuddyAI\\WorkBuddyAI.exe",0',
      "D:\\program\\WorkBuddy\\WorkBuddyAI\\WorkBuddyAI.exe",
    ],
    [
      "D:\\program\\WorkBuddy\\WorkBuddyAI\\WorkBuddyAI.exe,0",
      "D:\\program\\WorkBuddy\\WorkBuddyAI\\WorkBuddyAI.exe",
    ],
    ['"C:\\Apps\\WorkBuddy AI.exe"', "C:\\Apps\\WorkBuddy AI.exe"],
    ["C:\\Apps\\WorkBuddy.exe", "C:\\Apps\\WorkBuddy.exe"],
  ])("parses DisplayIcon %s", (value, expected) => {
    expect(parseWindowsDisplayIcon(value)).toBe(expected);
  });

  it("extracts WorkBuddy EXE paths from uninstall registry output", () => {
    const output = [
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WorkBuddyAI",
      "    DisplayName    REG_SZ    WorkBuddy AI",
      '    DisplayIcon    REG_SZ    "D:\\program\\WorkBuddy\\WorkBuddyAI\\WorkBuddyAI.exe",0',
      "HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OtherApp",
      "    DisplayName    REG_SZ    Other App",
      "    DisplayIcon    REG_SZ    C:\\Other\\App.exe,0",
    ].join("\r\n");
    expect(parseUninstallRegistryOutput(output)).toEqual([
      "D:\\program\\WorkBuddy\\WorkBuddyAI\\WorkBuddyAI.exe",
    ]);
  });
});

describe("uninstall hive pairing early-stop", () => {
  const brokenExe = "C:\\Users\\Broken\\WorkBuddy.exe";
  const goodExe = "C:\\Program Files\\WorkBuddy\\WorkBuddy.exe";
  const goodCli = "C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy";
  const otherExe = "C:\\Program Files\\WorkBuddy AI\\WorkBuddy AI.exe";
  const otherCli =
    "C:\\Program Files\\WorkBuddy AI\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy";

  it("skips a hive whose candidates fail pairing and uses a later hive", () => {
    const isExecutable = (candidate: string) => candidate === goodExe || candidate === goodCli;
    expect(selectPairedExecutablesFromHives([[brokenExe], [goodExe]], isExecutable)).toEqual([
      goodExe,
    ]);
  });

  it("stops after the first hive that yields a successful EXE+CLI pair", () => {
    const isExecutable = (candidate: string) =>
      [goodExe, goodCli, otherExe, otherCli].includes(candidate);
    let pulled = 0;
    function* hives(): Generator<string[]> {
      pulled += 1;
      yield [goodExe];
      pulled += 1;
      yield [otherExe];
    }
    expect(selectPairedExecutablesFromHives(hives(), isExecutable)).toEqual([goodExe]);
    expect(pulled).toBe(1);
  });

  it("returns nothing when every hive fails pairing", () => {
    expect(selectPairedExecutablesFromHives([[brokenExe], [otherExe]], () => false)).toEqual([]);
  });
});

describe("Shell Link LocalBasePath + CommonPathSuffix", () => {
  it("appends a nonempty ANSI CommonPathSuffix to LocalBasePath", () => {
    const buffer = buildMinimalShellLink({
      ansiBase: Buffer.from("D:\\program\\WorkBuddy\\", "utf8"),
      ansiSuffix: Buffer.from("WorkBuddyAI\\WorkBuddyAI.exe", "utf8"),
    });
    expect(parseWindowsShortcutTargetBuffer(buffer)).toBe(
      "D:\\program\\WorkBuddy\\WorkBuddyAI\\WorkBuddyAI.exe",
    );
  });

  it("keeps ANSI LocalBasePath when CommonPathSuffix is empty", () => {
    const buffer = buildMinimalShellLink({
      ansiBase: Buffer.from("D:\\program\\WorkBuddy\\WorkBuddyAI\\WorkBuddyAI.exe", "utf8"),
      ansiSuffix: Buffer.alloc(0),
    });
    expect(parseWindowsShortcutTargetBuffer(buffer)).toBe(
      "D:\\program\\WorkBuddy\\WorkBuddyAI\\WorkBuddyAI.exe",
    );
  });

  it("appends a nonempty Unicode CommonPathSuffix to LocalBasePathUnicode", () => {
    const buffer = buildMinimalShellLink({
      ansiBase: Buffer.from("C:\\ignored\\", "utf8"),
      ansiSuffix: Buffer.from("ignored.exe", "utf8"),
      unicodeBase: "D:\\自定义\\WorkBuddy\\",
      unicodeSuffix: "WorkBuddyAI.exe",
    });
    expect(parseWindowsShortcutTargetBuffer(buffer)).toBe("D:\\自定义\\WorkBuddy\\WorkBuddyAI.exe");
  });

  it("keeps Unicode LocalBasePath when CommonPathSuffixUnicode is empty", () => {
    const buffer = buildMinimalShellLink({
      ansiBase: Buffer.from("C:\\ignored.exe", "utf8"),
      ansiSuffix: Buffer.alloc(0),
      unicodeBase: "D:\\自定义\\WorkBuddy\\WorkBuddyAI.exe",
      unicodeSuffix: "",
    });
    expect(parseWindowsShortcutTargetBuffer(buffer)).toBe("D:\\自定义\\WorkBuddy\\WorkBuddyAI.exe");
  });

  it("decodes non-ASCII ANSI paths with an injectable ACP decoder", () => {
    // GBK bytes for "D:\程序\WorkBuddy\WorkBuddyAI.exe"
    const gbkPath = Buffer.from([
      0x44, 0x3a, 0x5c, 0xb3, 0xcc, 0xd0, 0xf2, 0x5c, 0x57, 0x6f, 0x72, 0x6b, 0x42, 0x75, 0x64,
      0x64, 0x79, 0x5c, 0x57, 0x6f, 0x72, 0x6b, 0x42, 0x75, 0x64, 0x64, 0x79, 0x41, 0x49, 0x2e,
      0x65, 0x78, 0x65,
    ]);
    const buffer = buildMinimalShellLink({
      ansiBase: gbkPath,
      ansiSuffix: Buffer.alloc(0),
    });
    const decodeAnsi = (bytes: Uint8Array) => new TextDecoder("gbk").decode(bytes);
    expect(parseWindowsShortcutTargetBuffer(buffer, { decodeAnsi })).toBe(
      "D:\\程序\\WorkBuddy\\WorkBuddyAI.exe",
    );
    // Fixed UTF-8 decoding would corrupt the GBK path.
    expect(parseWindowsShortcutTargetBuffer(buffer)).not.toBe(
      "D:\\程序\\WorkBuddy\\WorkBuddyAI.exe",
    );
  });

  it("decodes ANSI base and suffix with the same injectable code page", () => {
    const gbkBase = Buffer.from([0x44, 0x3a, 0x5c, 0xb3, 0xcc, 0xd0, 0xf2, 0x5c]); // D:\程序\
    const gbkSuffix = Buffer.from("WorkBuddyAI.exe", "utf8");
    const buffer = buildMinimalShellLink({ ansiBase: gbkBase, ansiSuffix: gbkSuffix });
    const decodeAnsi = (bytes: Uint8Array) => new TextDecoder("gbk").decode(bytes);
    expect(parseWindowsShortcutTargetBuffer(buffer, { decodeAnsi })).toBe(
      "D:\\程序\\WorkBuddyAI.exe",
    );
  });

  it("maps common Windows ACP values to TextDecoder labels", () => {
    expect(mapWindowsAcpToEncoding(936)).toBe("gbk");
    expect(mapWindowsAcpToEncoding(1252)).toBe("windows-1252");
    expect(mapWindowsAcpToEncoding(65001)).toBe("utf-8");
    expect(mapWindowsAcpToEncoding(99999)).toBe("utf-8");
  });
});

/**
 * Build a minimal Shell Link (.lnk) with LinkInfo LocalBasePath / CommonPathSuffix
 * (and optional Unicode counterparts) for parser unit tests.
 */
function buildMinimalShellLink(options: {
  ansiBase: Buffer;
  ansiSuffix: Buffer;
  unicodeBase?: string;
  unicodeSuffix?: string;
}): Buffer {
  const hasUnicode = options.unicodeBase !== undefined;
  const headerSize = 0x4c;
  const linkInfoHeaderSize = hasUnicode ? 0x24 : 0x1c;
  const volumeId = Buffer.alloc(0x11);
  volumeId.writeUInt32LE(0x11, 0);
  volumeId.writeUInt32LE(3, 4); // DRIVE_FIXED
  volumeId.writeUInt32LE(0, 8);
  volumeId.writeUInt32LE(0x10, 12); // VolumeLabelOffset -> empty ANSI label
  volumeId[0x10] = 0;

  const ansiBase = Buffer.concat([options.ansiBase, Buffer.from([0])]);
  const ansiSuffix = Buffer.concat([options.ansiSuffix, Buffer.from([0])]);
  const unicodeBase = hasUnicode
    ? Buffer.concat([Buffer.from(options.unicodeBase!, "utf16le"), Buffer.alloc(2)])
    : Buffer.alloc(0);
  const unicodeSuffix = hasUnicode
    ? Buffer.concat([Buffer.from(options.unicodeSuffix ?? "", "utf16le"), Buffer.alloc(2)])
    : Buffer.alloc(0);

  let cursor = linkInfoHeaderSize;
  const volumeIdOffset = cursor;
  cursor += volumeId.length;
  const localBasePathOffset = cursor;
  cursor += ansiBase.length;
  const commonPathSuffixOffset = cursor;
  cursor += ansiSuffix.length;
  let localBasePathOffsetUnicode = 0;
  let commonPathSuffixOffsetUnicode = 0;
  if (hasUnicode) {
    localBasePathOffsetUnicode = cursor;
    cursor += unicodeBase.length;
    commonPathSuffixOffsetUnicode = cursor;
    cursor += unicodeSuffix.length;
  }
  const linkInfoSize = cursor;

  const linkInfo = Buffer.alloc(linkInfoSize);
  linkInfo.writeUInt32LE(linkInfoSize, 0);
  linkInfo.writeUInt32LE(linkInfoHeaderSize, 4);
  linkInfo.writeUInt32LE(0x01, 8); // VolumeIDAndLocalBasePath
  linkInfo.writeUInt32LE(volumeIdOffset, 0x0c);
  linkInfo.writeUInt32LE(localBasePathOffset, 0x10);
  linkInfo.writeUInt32LE(0, 0x14); // no CommonNetworkRelativeLink
  linkInfo.writeUInt32LE(commonPathSuffixOffset, 0x18);
  if (hasUnicode) {
    linkInfo.writeUInt32LE(localBasePathOffsetUnicode, 0x1c);
    linkInfo.writeUInt32LE(commonPathSuffixOffsetUnicode, 0x20);
  }
  volumeId.copy(linkInfo, volumeIdOffset);
  ansiBase.copy(linkInfo, localBasePathOffset);
  ansiSuffix.copy(linkInfo, commonPathSuffixOffset);
  if (hasUnicode) {
    unicodeBase.copy(linkInfo, localBasePathOffsetUnicode);
    unicodeSuffix.copy(linkInfo, commonPathSuffixOffsetUnicode);
  }

  const header = Buffer.alloc(headerSize);
  header.writeUInt32LE(headerSize, 0);
  header.writeUInt32LE(0x02, 0x14); // HasLinkInfo only

  return Buffer.concat([header, linkInfo]);
}

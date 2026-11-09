import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cursorCliApprovalModeIsUnrestricted,
  protobufBytes,
  readCursorNativeTurns,
} from "../src/native-history.js";

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function varint(value: number): Buffer {
  const bytes: number[] = [];
  do {
    bytes.push((value & 127) | (value > 127 ? 128 : 0));
    value = Math.floor(value / 128);
  } while (value);
  return Buffer.from(bytes);
}
function field(id: number, value: Buffer | string) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([varint(id * 8 + 2), varint(data.length), data]);
}
function fixture(texts = ["first", "second"], notifications: number[] = []) {
  const home = mkdtempSync(path.join(os.tmpdir(), "codexhost-cursor-history-"));
  temporary.push(home);
  const sessionId = randomUUID();
  const directory = path.join(home, ".cursor", "acp-sessions", sessionId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "meta.json"), JSON.stringify({ cwd: home }));
  const db = new DatabaseSync(path.join(directory, "store.db"));
  db.exec(
    "CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB)",
  );
  const put = (data: Buffer) => {
    const id = createHash("sha256").update(data).digest();
    db.prepare("INSERT OR IGNORE INTO blobs VALUES(?,?)").run(id.toString("hex"), data);
    return id;
  };
  const turns = texts.map((text, index) => ({
    id: randomUUID(),
    text,
    ...(notifications.includes(index) ? { notification: true as const } : {}),
  }));
  const root = put(
    Buffer.concat(
      turns.map((turn) =>
        field(
          8,
          put(
            field(
              1,
              field(
                1,
                put(
                  Buffer.concat([
                    field(1, turn.text),
                    field(2, turn.id),
                    ...(turn.notification ? [field(15, field(1, "background task"))] : []),
                  ]),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  db.prepare("INSERT INTO meta VALUES('0',?)").run(
    Buffer.from(
      JSON.stringify({ agentId: sessionId, latestRootBlobId: root.toString("hex") }),
    ).toString("hex"),
  );
  db.close();
  return { home, sessionId, turns };
}
describe("Cursor read-only native identity", () => {
  it("returns stable ordered native IDs from a freshly opened store", () => {
    const f = fixture();
    expect(readCursorNativeTurns(f.sessionId, f.home, { HOME: f.home })).toEqual(f.turns);
    expect(readCursorNativeTurns(f.sessionId, f.home, { HOME: f.home })).toEqual(f.turns);
  }, 15_000);
  it("accepts a symlink to the same native workspace", () => {
    const f = fixture();
    const link = path.join(f.home, "workspace-link");
    symlinkSync(f.home, link, "junction");
    expect(readCursorNativeTurns(f.sessionId, link, { HOME: f.home })).toEqual(f.turns);
  });
  it("accepts the native on-disk case of a case-insensitive workspace path", (context) => {
    const f = fixture();
    const workspace = path.join(f.home, "Github", "project");
    mkdirSync(workspace, { recursive: true });
    const requested = path.join(f.home, "github", "project");
    if (!existsSync(requested)) context.skip();
    writeFileSync(
      path.join(f.home, ".cursor", "acp-sessions", f.sessionId, "meta.json"),
      JSON.stringify({ cwd: workspace }),
    );
    expect(readCursorNativeTurns(f.sessionId, requested, { HOME: f.home })).toEqual(f.turns);
  });
  it("marks user records Cursor wrote for finished background tasks", () => {
    const f = fixture(["prompt", "<system_notification>task finished</system_notification>"], [1]);
    const turns = readCursorNativeTurns(f.sessionId, f.home, { HOME: f.home });
    expect(turns).toEqual(f.turns);
    expect(turns[0]).not.toHaveProperty("notification");
    expect(turns[1]).toMatchObject({ notification: true });
  });
  it("allows a new empty history without inventing IDs", () => {
    const f = fixture([]);
    expect(readCursorNativeTurns(f.sessionId, f.home, { HOME: f.home })).toEqual([]);
  });
  it("rejects workspace mismatch and path traversal", () => {
    const f = fixture();
    expect(() =>
      readCursorNativeTurns(f.sessionId, path.join(f.home, "other"), { HOME: f.home }),
    ).toThrow("workspace");
    expect(() => readCursorNativeTurns("../../outside", f.home, { HOME: f.home })).toThrow(
      "session ID",
    );
  });
  it("does not treat missing history as empty on resume", () => {
    const f = fixture();
    expect(() => readCursorNativeTurns(randomUUID(), f.home, { HOME: f.home })).toThrow();
    expect(readCursorNativeTurns(randomUUID(), f.home, { HOME: f.home }, true)).toEqual([]);
  });
  it.each([{ bytes: [0x80] }, { bytes: [0x0a, 20, 1] }, { bytes: [0x0b, 0] }, { bytes: [0] }])(
    "rejects malformed protobuf $bytes",
    ({ bytes }) => {
      expect(() => protobufBytes(Buffer.from(bytes))).toThrow();
    },
  );
});

describe("Cursor CLI approvalMode", () => {
  function config(directory: string, approvalMode: string) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "cli-config.json"), JSON.stringify({ approvalMode }));
  }
  it.each(["allowlist", "unrestricted"])(
    "uses Windows USERPROFILE rather than HOME when its mode is %s",
    (mode) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "codexhost-cursor-approval-"));
      temporary.push(root);
      const environment = {
        HOME: path.join(root, "home"),
        USERPROFILE: path.join(root, "profile"),
      };
      config(
        path.join(environment.HOME, ".cursor"),
        mode === "allowlist" ? "unrestricted" : "allowlist",
      );
      config(path.join(environment.USERPROFILE, ".cursor"), mode);
      vi.stubGlobal("process", { ...process, platform: "win32" });
      expect(cursorCliApprovalModeIsUnrestricted(environment)).toBe(mode === "unrestricted");
    },
  );
  it.each(["darwin", "linux", "win32"])(
    "keeps absolute override precedence and native default paths on %s",
    (platform) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "codexhost-cursor-approval-"));
      temporary.push(root);
      const environment = {
        HOME: path.join(root, "home"),
        USERPROFILE: path.join(root, "profile"),
      };
      config(
        path.join(platform === "win32" ? environment.USERPROFILE : environment.HOME, ".cursor"),
        "unrestricted",
      );
      vi.stubGlobal("process", { ...process, platform });
      expect(cursorCliApprovalModeIsUnrestricted(environment)).toBe(true);
      vi.spyOn(os, "homedir").mockReturnValue(path.join(root, "parent-home"));
      vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: environment.HOME });
      config(path.join(environment.HOME, ".cursor"), "unrestricted");
      expect(cursorCliApprovalModeIsUnrestricted({})).toBe(true);

      const xdg = { ...environment, XDG_CONFIG_HOME: path.join(root, "xdg") };
      config(path.join(xdg.XDG_CONFIG_HOME, "cursor"), "allowlist");
      expect(cursorCliApprovalModeIsUnrestricted(xdg)).toBe(false);
      const cursor = { ...xdg, CURSOR_CONFIG_DIR: path.join(root, "cursor") };
      config(cursor.CURSOR_CONFIG_DIR, "unrestricted");
      expect(cursorCliApprovalModeIsUnrestricted(cursor)).toBe(true);
    },
  );
  it("detects unrestricted and stays false for missing or other modes", () => {
    const missing = mkdtempSync(path.join(os.tmpdir(), "codexhost-cursor-approval-"));
    temporary.push(missing);
    expect(cursorCliApprovalModeIsUnrestricted({ CURSOR_CONFIG_DIR: missing })).toBe(false);

    const allowlist = mkdtempSync(path.join(os.tmpdir(), "codexhost-cursor-approval-"));
    temporary.push(allowlist);
    writeFileSync(
      path.join(allowlist, "cli-config.json"),
      JSON.stringify({ version: 1, approvalMode: "allowlist" }),
    );
    expect(cursorCliApprovalModeIsUnrestricted({ CURSOR_CONFIG_DIR: allowlist })).toBe(false);

    const unrestricted = mkdtempSync(path.join(os.tmpdir(), "codexhost-cursor-approval-"));
    temporary.push(unrestricted);
    writeFileSync(
      path.join(unrestricted, "cli-config.json"),
      JSON.stringify({ version: 1, approvalMode: "unrestricted" }),
    );
    expect(cursorCliApprovalModeIsUnrestricted({ CURSOR_CONFIG_DIR: unrestricted })).toBe(true);

    const broken = mkdtempSync(path.join(os.tmpdir(), "codexhost-cursor-approval-"));
    temporary.push(broken);
    writeFileSync(path.join(broken, "cli-config.json"), "{");
    expect(cursorCliApprovalModeIsUnrestricted({ CURSOR_CONFIG_DIR: broken })).toBe(false);
  });
});

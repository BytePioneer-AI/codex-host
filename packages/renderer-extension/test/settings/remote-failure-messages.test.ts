import { describe, expect, it } from "vitest";

import { localizeRemoteFailure } from "../../src/settings/remote-failure-messages.js";

const zh = (chinese: string): string => chinese;
const en = (_chinese: string, english: string): string => english;

describe("remote failure messages", () => {
  it("shows a known failure in Chinese and keeps the English wording for English", () => {
    const message = "A connection with this name already exists";
    expect(localizeRemoteFailure(message, zh)).toBe("已存在同名的连接");
    expect(localizeRemoteFailure(message, en)).toBe(message);
  });

  it("recognises a failure followed by a detail or recorded with its error class", () => {
    expect(
      localizeRemoteFailure(
        "The requested release is unavailable or npm cannot reach the registry: remote update command failed (exit status: 1)",
        zh,
      ),
    ).toBe("目标版本不存在，或远程电脑无法访问 npm 仓库");
    expect(localizeRemoteFailure("Error: Remote updater is unavailable", zh)).toBe(
      "远程更新程序不可用",
    );
    expect(localizeRemoteFailure("Remote stop failed: timed out", zh)).toBe(
      "更新已安装，但停止旧服务失败",
    );
  });

  it("leaves SSH and Codex output it does not know unchanged", () => {
    const native = "ssh: connect to host 100.110.60.56 port 22: Operation timed out";
    expect(localizeRemoteFailure(native, zh)).toBe(native);
    expect(localizeRemoteFailure("远程服务已修复，正在连接", zh)).toBe("远程服务已修复，正在连接");
  });
});

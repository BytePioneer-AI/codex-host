import { describe, expect, it, vi } from "vitest";

import { readAnnouncement } from "../src/announcement.js";

describe("console announcement source", () => {
  it("reads the fork NOTICE.md through the announcement fetch path", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("---\nenabled: true\ntitle: Fork update\ntype: info\n---\nFork release notes"),
    );

    await expect(readAnnouncement(fetcher)).resolves.toEqual({
      title: "Fork update",
      type: "info",
      body: "Fork release notes",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/karlorz/codex-host/main/docs/NOTICE.md",
      expect.objectContaining({ redirect: "error", cache: "no-store" }),
    );
  });

  it("hides an unavailable fork announcement without retrying", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 404 }));

    await expect(readAnnouncement(fetcher)).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

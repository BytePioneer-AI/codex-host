import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { describe, expect, it } from "vitest";

import { SdkOpenCodeTransport } from "../src/sdk-transport.js";

describe("OpenCode SDK command normalization", () => {
  it("normalizes a non-string command template at the SDK boundary", async () => {
    const client = {
      command: {
        list: async () => ({
          data: [
            {
              name: "review",
              description: "Review the workspace",
              template: {},
              hints: [],
            },
          ],
          error: undefined,
        }),
      },
    } as unknown as OpencodeClient;
    const connection = {
      stderrTail: "",
      client: async () => client,
      close: async () => undefined,
    };
    const transport = new SdkOpenCodeTransport(connection, "/synthetic", {
      commandTimeoutMs: 100,
    });

    await expect(transport.commands()).resolves.toEqual([
      expect.objectContaining({ name: "review", template: "" }),
    ]);
  });
});

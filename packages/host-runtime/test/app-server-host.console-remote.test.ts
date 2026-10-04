import { expect, it, vi } from "vitest";
import {
  CONSOLE_REMOTE_CONNECTIONS_METHOD,
  REMOTE_SSH_SETUP_METHOD,
  RUNTIME_STATUS_METHOD,
} from "@codexhost/shared-contracts";
import { RuntimeMaintenance } from "../src/runtime-maintenance.js";
import { createFixture, stopFixture } from "./app-server-host-fixture.js";

it("limits console remote management to validated settings requests", async () => {
  const maintenance = new RuntimeMaintenance({
    runtimePath: import.meta.filename,
    remote: false,
    environment: {},
  });
  const setup = vi.spyOn(maintenance, "setupSsh");
  const fixture = createFixture({
    runtimeMaintenance: maintenance,
    environment: { CODEXHOST_CONTROL_PORT: "", CODEXHOST_CONTROL_NONCE: "" },
  });
  try {
    await fixture.ready;
    expect(
      await fixture.host.handleConsoleRequest(CONSOLE_REMOTE_CONNECTIONS_METHOD, {
        action: "list",
      }),
    ).toMatchObject({ error: { code: -32090 } });
    expect(
      await fixture.host.handleConsoleRequest(CONSOLE_REMOTE_CONNECTIONS_METHOD, {
        action: "eval",
        expression: "code",
      }),
    ).toMatchObject({ error: { code: -32602 } });
    expect(
      await fixture.host.handleConsoleRequest(REMOTE_SSH_SETUP_METHOD, {
        action: "uninstall",
        command: "code",
      }),
    ).toMatchObject({ error: { code: -32090 } });
    expect(setup).not.toHaveBeenCalled();
    expect(await fixture.host.handleConsoleRequest(RUNTIME_STATUS_METHOD, {})).toHaveProperty(
      "result",
    );
    expect(
      await fixture.host.handleConsoleRequest("codexhost/remote/update", { version: "0.12.0" }),
    ).toMatchObject({ error: { code: -32601 } });
    expect(await fixture.host.handleConsoleRequest("thread/start", {})).toMatchObject({
      error: { code: -32601 },
    });
  } finally {
    await stopFixture(fixture);
  }
});

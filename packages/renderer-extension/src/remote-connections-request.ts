import { remoteConnectionsRequestSchema } from "@codexhost/shared-contracts";
import type { RemoteConnectionsControl } from "./remote-connections-control.js";

/** Uses the same native settings and Host clients as the embedded settings page. */
export async function handleRemoteConnectionsRequest(
  control: RemoteConnectionsControl,
  input: unknown,
): Promise<unknown> {
  const request = remoteConnectionsRequestSchema.parse(input);
  switch (request.action) {
    case "session":
      throw new Error("Remote sessions require the Desktop Controller route");
    case "read-thread":
      if (!control.readThread) throw new Error("Remote Thread reading is unavailable");
      return control.readThread(request.hostId, request.input);
    case "list":
      return control.ssh.list();
    case "catalog":
      return control.ssh.catalog?.() ?? control.ssh.list();
    case "save":
      await control.ssh.save(request.draft, request.previous);
      return null;
    case "remove":
      await control.ssh.remove(request.previous);
      return null;
    case "connect":
      await control.ssh.connect(request.hostId, request.enabled);
      return null;
    case "state":
      return control.ssh.state(request.hostId);
    case "runtime":
      return control.runtime(request.hostId);
    case "update":
      return control.update(request.hostId, request.version);
  }
}

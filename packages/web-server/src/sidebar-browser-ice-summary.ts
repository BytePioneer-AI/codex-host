import { isIP } from "node:net";
import { IceCandidate, type RTCIceTransport } from "werift";

const counts = () => ({ host: 0, srflx: 0, prflx: 0 });

class Candidates {
  private readonly seen = new Set<string>();
  private readonly totals = { ipv4: counts(), ipv6: counts() };

  add(type: string, address: string, port: number, protocol: string): void {
    if (type !== "host" && type !== "srflx" && type !== "prflx") return;
    const family = isIP(address);
    if (!family) return; // An unresolved mDNS name does not identify an address family.
    const key = `${type}/${address}/${port}/${protocol.toLowerCase()}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.totals[family === 4 ? "ipv4" : "ipv6"][type]++;
  }

  summary() {
    return this.totals;
  }
}

/** Only the counts leave this object. Addresses are used to deduplicate SDP, trickle and ICE. */
export class SidebarBrowserIceSummary {
  private readonly remote = new Candidates();
  private remoteSrflxReceived = false;

  received(candidate: IceCandidate): void {
    this.remote.add(candidate.type, candidate.ip, candidate.port, candidate.protocol);
    if (candidate.type === "srflx") this.remoteSrflxReceived = true;
  }

  receivedLine(line: string): void {
    const candidate = IceCandidate.fromJSON({ candidate: line });
    if (candidate) this.received(candidate);
  }

  summary(ice?: RTCIceTransport) {
    const local = new Candidates();
    for (const candidate of ice?.connection.localCandidates ?? [])
      local.add(candidate.type, candidate.host, candidate.port, candidate.transport);
    // werift's getRemoteCandidates() filters peer-reflexive candidates out.
    for (const candidate of ice?.connection.remoteCandidates ?? [])
      this.remote.add(candidate.type, candidate.host, candidate.port, candidate.transport);
    return {
      local: local.summary(),
      remote: this.remote.summary(),
      remoteSrflxReceived: this.remoteSrflxReceived,
    };
  }
}

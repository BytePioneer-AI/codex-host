import { directNetworkKey } from "./DirectBackoff.ts";

const NETWORK_PROBE_MS = 2_000;

/** Prepare the offer on the real connection and release it on the first STUN reflection. */
export async function prepareDirectOffer(
  pc: RTCPeerConnection,
  restart: boolean,
  signal: AbortSignal,
  candidate: (value: RTCIceCandidate | null) => void,
): Promise<{ sdp: string; network: string }> {
  const offer = await pc.createOffer({ iceRestart: restart });
  if (signal.aborted) throw signal.reason;
  const sdp = offer.sdp!;
  const ufrag = /^a=ice-ufrag:(\S+)/m.exec(sdp)?.[1];
  let resolveNetwork!: (key: string) => void;
  const network = new Promise<string>((resolve) => {
    resolveNetwork = resolve;
  });
  let resolved = false;
  const selectNetwork = (address?: string): void => {
    if (resolved) return;
    resolved = true;
    resolveNetwork(directNetworkKey(address));
  };
  const finish = (): void => selectNetwork();
  const timer = setTimeout(finish, NETWORK_PROBE_MS);
  signal.addEventListener("abort", finish, { once: true });
  pc.addEventListener(
    "icecandidate",
    (event) => {
      const ice = event.candidate;
      if (ice?.candidate === "" || (ice === null && pc.iceGatheringState !== "complete")) return;
      // During a restart, native ICE callbacks from the preceding credentials can still arrive.
      if (restart && ice) {
        const username = ice.usernameFragment || /\bufrag (\S+)/u.exec(ice.candidate)?.[1];
        if (username && ufrag && username !== ufrag) return;
      }
      candidate(ice);
      if (resolved) return;
      if (ice === null) finish();
      else {
        // Safari versions without the parsed fields still supply the SDP candidate line.
        const fields = ice.candidate.split(" ");
        const address = ice.address || fields[4];
        if ((ice.type ?? fields[7]) === "srflx" && address) {
          selectNetwork(address);
        }
      }
    },
    { signal },
  );
  try {
    await pc.setLocalDescription(offer);
    const key = await network;
    if (signal.aborted) throw signal.reason;
    return { sdp, network: key };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", finish);
  }
}

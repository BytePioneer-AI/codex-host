export interface UsageDetails {
  /** upload is phone to computer; download is computer to phone. */
  direction: "upload" | "download";
  acme: boolean;
  quotaExceeded: boolean;
}

interface ComputerEvent {
  type: "computer";
  name: string;
  ip: string | undefined;
  time: number;
}

interface PhoneEvent {
  type: "phone";
  id: string;
  name: string;
  ip: string | undefined;
  startedAt: number;
  acme: boolean;
}

export type ConnectionEvent =
  | (ComputerEvent & { state: "online" })
  | (ComputerEvent & {
      state: "offline";
      reason: "replace" | "unregister" | "timeout";
    })
  | (PhoneEvent & { state: "open" })
  | (PhoneEvent & { state: "authenticated"; time: number })
  | (PhoneEvent & {
      state: "close";
      endedAt: number;
      upload: number;
      download: number;
    });

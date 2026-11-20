const STORAGE_KEY = "codexhost.direct.v1";
const MINUTE = 60_000;
const COOLDOWNS = [10 * MINUTE, 60 * MINUTE, 360 * MINUTE, 1440 * MINUTE] as const;
const MAX_NETWORKS = 32;

type Failure = { failures: number; until: number };
type Target = { boot: string; networks: Record<string, Failure> };

function networkAddress(address: string): string {
  if (!address.includes(":")) return address;
  // Canonicalize first so that compressed, expanded and IPv4-mapped forms agree.
  const hostname = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const [head = "", tail] = hostname.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail ? tail.split(":") : [];
  const words =
    tail === undefined
      ? left
      : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return `${words.slice(0, 4).join(":")}::/64`;
}

/** Key the network by the first STUN reflection, without storing its raw address. */
export function directNetworkKey(address: string | undefined): string {
  if (address === undefined) return "none";
  let hash = 0xcbf29ce484222325n;
  for (const char of networkAddress(address))
    hash = BigInt.asUintN(64, (hash ^ BigInt(char.charCodeAt(0))) * 0x100000001b3n);
  return `ip-${hash.toString(16)}`;
}

/** Failure records live on this page even when browser storage is blocked. */
export class DirectBackoff {
  private readonly targets = new Map<string, Target>();

  constructor(private readonly storage: () => Pick<Storage, "getItem" | "setItem">) {
    try {
      const entries = JSON.parse(storage().getItem(STORAGE_KEY) ?? "{}") as Record<string, Target>;
      for (const [id, entry] of Object.entries(entries))
        if (typeof entry?.boot === "string" && entry.networks && typeof entry.networks === "object")
          this.targets.set(id, entry);
    } catch {
      // Unavailable storage or unreadable data: start with an empty page cache.
    }
  }

  setBoot(target: string, boot: string): void {
    const previous = this.targets.get(target);
    if (previous?.boot === boot) return;
    this.targets.set(target, { boot, networks: {} });
    if (previous !== undefined) this.save();
  }

  cooling(target: string, network: string, now: number): boolean {
    return (this.target(target).networks[network]?.until ?? 0) > now;
  }

  failed(target: string, network: string, now: number): void {
    const { networks } = this.target(target);
    const failures = (networks[network]?.failures ?? 0) + 1;
    const cooldown = COOLDOWNS[Math.min(failures, COOLDOWNS.length) - 1]!;
    // Object insertion order keeps the most recently failed networks at the end.
    delete networks[network];
    networks[network] = { failures, until: now + cooldown };
    const keys = Object.keys(networks);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_NETWORKS))) delete networks[key];
    this.save();
  }

  succeeded(target: string, network: string): void {
    const { networks } = this.target(target);
    if (Object.hasOwn(networks, network)) {
      delete networks[network];
      this.save();
    }
  }

  private target(target: string): Target {
    return this.targets.get(target)!;
  }

  private save(): void {
    try {
      this.storage().setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.targets)));
    } catch {
      // Keep the page cache when storage cannot be written.
    }
  }
}

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
  private memoryOnly = false;

  constructor(private readonly storage: () => Pick<Storage, "getItem" | "setItem">) {}

  setBoot(target: string, boot: string): void {
    const stored = this.read();
    const previous = (stored ?? this.targets).get(target);
    const entry = previous?.boot === boot ? previous : { boot, networks: {} };
    this.targets.set(target, entry);
    if (entry !== previous) this.save(stored, target, entry);
  }

  cooling(target: string, network: string, now: number): boolean {
    return (this.target(target, this.read())?.networks[network]?.until ?? 0) > now;
  }

  failed(target: string, network: string, now: number): void {
    const stored = this.read();
    const entry = this.target(target, stored);
    if (entry === undefined) return;
    const { networks } = entry;
    const failures = (networks[network]?.failures ?? 0) + 1;
    const cooldown = COOLDOWNS[Math.min(failures, COOLDOWNS.length) - 1]!;
    // Object insertion order keeps the most recently failed networks at the end.
    delete networks[network];
    networks[network] = { failures, until: now + cooldown };
    const keys = Object.keys(networks);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_NETWORKS))) delete networks[key];
    this.save(stored, target, entry);
  }

  succeeded(target: string, network: string): void {
    const stored = this.read();
    const entry = this.target(target, stored);
    if (entry && Object.hasOwn(entry.networks, network)) {
      delete entry.networks[network];
      this.save(stored, target, entry);
    }
  }

  private target(target: string, stored: Map<string, Target> | undefined): Target | undefined {
    const local = this.targets.get(target);
    if (stored === undefined) return local;
    const latest = stored.get(target);
    // A pending result from another boot must not update the current boot's records.
    if (local && latest && local.boot !== latest.boot) return undefined;
    if (latest) this.targets.set(target, latest);
    else if (local) this.targets.set(target, { boot: local.boot, networks: {} });
    return this.targets.get(target);
  }

  private read(): Map<string, Target> | undefined {
    if (this.memoryOnly) return undefined;
    try {
      const entries = JSON.parse(this.storage().getItem(STORAGE_KEY) ?? "{}") as Record<
        string,
        Target
      >;
      return new Map(
        Object.entries(entries).filter(
          ([, entry]) =>
            typeof entry?.boot === "string" && entry.networks && typeof entry.networks === "object",
        ),
      );
    } catch {
      this.memoryOnly = true;
      return undefined;
    }
  }

  private save(stored: Map<string, Target> | undefined, target: string, entry: Target): void {
    if (stored === undefined) return;
    stored.set(target, entry);
    try {
      this.storage().setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(stored)));
    } catch {
      this.memoryOnly = true;
    }
  }
}

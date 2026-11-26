/**
 * Web Push notifications (VAPID) for phones and desktops.
 *
 * Home-screen PWAs on iOS 16.4+ and every Android/desktop browser accept standard Web Push, so
 * the Web UI can notify when a Turn finishes or an agent waits for an approval or an answer
 * without a native app. Keys and subscriptions live in the server data directory.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import { getProxyForUrl } from "proxy-from-env";
import { valid as validVersion } from "semver";
import webpush from "web-push";

import type { DataDir } from "./store.ts";
import { RpcError, type RpcRegistry } from "./transport.ts";

interface StoredSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: number;
  userAgent?: string;
  /** Credential that created this subscription; absent when authentication was disabled. */
  owner?: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Groups and replaces notifications for one Session. */
  tag?: string;
  /** Document-relative URL opened on click. */
  url?: string;
  sessionId?: string;
  kind: "turn" | "approval" | "question" | "error" | "test";
}

const KEYS_FILE = "push-keys.json";
const SUBSCRIPTIONS_FILE = "push-subscriptions.json";
const DESKTOP_SHELL_READY_FILE = "desktop-shell-ready.json";
const DESKTOP_ACTIVATION_TTL = 60_000;
const DESKTOP_ACTIVATION_LIMIT = 256;
const ACTIVATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const runLauncher = promisify(execFile);

interface DesktopActivation {
  endpoint: string;
  sessionId: string;
  credential: string;
  expiresAt: number;
  result: Promise<{ activated: boolean }>;
}

function isLiveDesktopShell(hostDataDirectory: string): boolean {
  let record: Record<string, unknown> | null;
  try {
    // Compare the exact JSON token: Windows FILETIME microseconds can exceed the safe Number range.
    record = JSON.parse(
      readFileSync(join(hostDataDirectory, DESKTOP_SHELL_READY_FILE), "utf8"),
      (key, value: unknown, context?: { source?: string }) => {
        if (key !== "started_at_micros") return value;
        const source = context?.source;
        return typeof value === "number" && source && /^[1-9][0-9]{0,19}$/u.test(source)
          ? BigInt(source)
          : undefined;
      },
    ) as Record<string, unknown> | null;
  } catch {
    return false;
  }
  if (!record) return false;
  const { pid, started_at_micros: startedAt, executable, version } = record;
  if (
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    pid < 1 ||
    pid > 0x7fff_ffff ||
    typeof startedAt !== "bigint" ||
    startedAt > 0xffff_ffff_ffff_ffffn ||
    typeof executable !== "string" ||
    !isAbsolute(executable) ||
    /\p{Cc}/u.test(executable) ||
    typeof version !== "string" ||
    !validVersion(version)
  ) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class PushNotifier {
  private readonly keys: { publicKey: string; privateKey: string };
  private subscriptions: StoredSubscription[];

  constructor(
    private readonly data: DataDir,
    subject = "https://github.com/BytePioneer-AI/codex-host",
  ) {
    const stored = data.readJson<{ publicKey?: string; privateKey?: string }>(KEYS_FILE, {});
    if (stored.publicKey === undefined || stored.privateKey === undefined) {
      this.keys = webpush.generateVAPIDKeys();
      data.writeJson(KEYS_FILE, this.keys);
    } else {
      this.keys = { publicKey: stored.publicKey, privateKey: stored.privateKey };
    }
    webpush.setVapidDetails(subject, this.keys.publicKey, this.keys.privateKey);
    this.subscriptions = data.readJson<StoredSubscription[]>(SUBSCRIPTIONS_FILE, []);
  }

  get subscriptionCount(): number {
    return this.subscriptions.length;
  }

  private save(): void {
    this.data.writeJson(SUBSCRIPTIONS_FILE, this.subscriptions);
  }

  /** Discard subscriptions that no longer belong to a valid credential. */
  retainOwners(isValid: (owner: string) => boolean): void {
    const kept = this.subscriptions.filter(
      (entry) => entry.owner !== undefined && isValid(entry.owner),
    );
    if (kept.length === this.subscriptions.length) return;
    this.subscriptions = kept;
    this.save();
  }

  /** Remove every subscription a revoked credential created. */
  dropOwner(owner: string): void {
    const kept = this.subscriptions.filter((entry) => entry.owner !== owner);
    if (kept.length === this.subscriptions.length) return;
    this.subscriptions = kept;
    this.save();
  }

  register(
    rpc: RpcRegistry,
    desktop?: {
      launcher: string;
      hostDataDirectory: string;
      launch?: (
        executable: string,
        args: string[],
        options: { env: NodeJS.ProcessEnv; windowsHide: boolean },
      ) => Promise<unknown>;
    },
  ): void {
    const activations = new Map<string, DesktopActivation>();
    rpc.register("codexhost/pushConfig", () => ({
      publicKey: this.keys.publicKey,
      subscriptions: this.subscriptions.length,
    }));
    rpc.register("codexhost/pushSubscribe", (args, context) => {
      const subscription = (args.subscription ??
        (args.request as { subscription?: unknown } | undefined)?.subscription) as
        Partial<StoredSubscription> | undefined;
      if (
        typeof subscription?.endpoint !== "string" ||
        typeof subscription.keys?.p256dh !== "string" ||
        typeof subscription.keys.auth !== "string"
      ) {
        throw new RpcError(
          "push/invalid-subscription",
          "A PushSubscription with endpoint and keys is required",
          {},
        );
      }
      this.subscriptions = this.subscriptions.filter(
        (entry) => entry.endpoint !== subscription.endpoint,
      );
      this.subscriptions.push({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
        createdAt: Date.now(),
        ...(typeof args.userAgent === "string" ? { userAgent: args.userAgent.slice(0, 200) } : {}),
        ...(context.auth === undefined ? {} : { owner: context.auth.credential }),
      });
      this.save();
      return { subscribed: true, subscriptions: this.subscriptions.length };
    });
    rpc.register("codexhost/pushUnsubscribe", (args) => {
      const endpoint = String(args.endpoint ?? "");
      this.subscriptions = this.subscriptions.filter((entry) => entry.endpoint !== endpoint);
      this.save();
      return { subscribed: false, subscriptions: this.subscriptions.length };
    });
    rpc.register("codexhost/desktopSessionActivate", async (args, context) => {
      const { requestId, endpoint, sessionId, retry } = args;
      const rejected = () => {
        if (retry === true) {
          throw new RpcError("push/activation-unknown", "Unable to verify the earlier activation");
        }
        return { activated: false };
      };
      const auth = context.auth;
      if (
        !desktop ||
        context.relay ||
        auth?.local !== true ||
        typeof requestId !== "string" ||
        !ACTIVATION_ID.test(requestId) ||
        typeof endpoint !== "string" ||
        typeof sessionId !== "string" ||
        sessionId.trim() === "" ||
        Buffer.byteLength(sessionId, "utf8") > 1024 ||
        /\p{Cc}/u.test(sessionId) ||
        !this.subscriptions.some(
          (entry) => entry.endpoint === endpoint && entry.owner === auth.credential,
        )
      ) {
        return rejected();
      }
      const now = Date.now();
      for (const [id, entry] of activations) {
        if (entry.expiresAt <= now) activations.delete(id);
      }
      const previous = activations.get(requestId);
      if (previous) {
        return previous.endpoint === endpoint &&
          previous.sessionId === sessionId &&
          previous.credential === auth.credential
          ? previous.result
          : rejected();
      }
      // A retry can only reconcile an earlier request, including after a server restart.
      if (retry === true || activations.size >= DESKTOP_ACTIVATION_LIMIT) return rejected();
      const entry: DesktopActivation = {
        endpoint,
        sessionId,
        credential: auth.credential,
        expiresAt: Infinity,
        result: Promise.resolve().then(async () => {
          try {
            const { launcher, hostDataDirectory, launch = runLauncher } = desktop;
            if (!isLiveDesktopShell(hostDataDirectory)) return { activated: false };
            await launch(launcher, ["app", "--session", sessionId], {
              env: { ...process.env, CODEXHOST_DATA_DIR: hostDataDirectory },
              windowsHide: true,
            });
            return { activated: true };
          } catch (error) {
            const failure = error as { code?: number | string; signal?: string | null } | null;
            // A process cut off after starting may already have handed the session to the shell.
            const code = failure?.code;
            const declined =
              failure?.signal == null &&
              (code === 1 || code === "ENOENT" || code === "EACCES" || code === "EPERM");
            return { activated: !declined };
          } finally {
            entry.expiresAt = Date.now() + DESKTOP_ACTIVATION_TTL;
          }
        }),
      };
      activations.set(requestId, entry);
      return entry.result;
    });
    rpc.register("codexhost/pushTest", async (args, context) => {
      const endpoint = args.endpoint;
      if (typeof endpoint !== "string" || endpoint.trim().length === 0)
        throw new RpcError(
          "push/invalid-subscription",
          "A PushSubscription endpoint is required",
          {},
        );
      const subscription = this.subscriptions.find((entry) => entry.endpoint === endpoint);
      if (!subscription || (context.auth && subscription.owner !== context.auth.credential))
        return { sent: 0 };
      const sent = await this.notify(
        {
          kind: "test",
          title: "通知测试",
          body: "这台设备可以正常接收通知。",
          tag: "codexhost-test",
        },
        endpoint,
      );
      return { sent };
    });
  }

  /** Deliver one message to every subscription; drops subscriptions the push service rejects as gone. */
  async notify(message: PushMessage, endpoint?: string): Promise<number> {
    const subscriptions =
      endpoint === undefined
        ? this.subscriptions
        : this.subscriptions.filter((entry) => entry.endpoint === endpoint);
    if (subscriptions.length === 0) return 0;
    const payload = JSON.stringify(message);
    let sent = 0;
    const gone: string[] = [];
    await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          // web-push's explicit proxy works even before Node's HTTPS environment-proxy support.
          const proxy =
            process.env.NODE_USE_ENV_PROXY === "1" ? getProxyForUrl(subscription.endpoint) : "";
          await webpush.sendNotification(subscription, payload, {
            TTL: 3600,
            urgency: message.kind === "turn" ? "normal" : "high",
            timeout: 10_000,
            ...(proxy ? { proxy } : {}),
          });
          sent += 1;
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) gone.push(subscription.endpoint);
          else
            console.error(
              "[push] delivery failed",
              status ?? "",
              error instanceof Error ? error.message : error,
            );
        }
      }),
    );
    if (gone.length > 0) {
      this.subscriptions = this.subscriptions.filter((entry) => !gone.includes(entry.endpoint));
      this.save();
    }
    return sent;
  }
}

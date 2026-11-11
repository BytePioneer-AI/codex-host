/**
 * Web Push notifications (VAPID) for phones and desktops.
 *
 * Home-screen PWAs on iOS 16.4+ and every Android/desktop browser accept standard Web Push, so
 * the Web UI can notify when a Turn finishes or an agent waits for an approval or an answer
 * without a native app. Keys and subscriptions live in the server data directory.
 */

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

  register(rpc: RpcRegistry): void {
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
    rpc.register("codexhost/pushTest", async () => {
      const sent = await this.notify({
        kind: "test",
        title: "通知测试",
        body: "这台设备可以正常接收通知。",
        tag: "codexhost-test",
      });
      return { sent };
    });
  }

  /** Deliver one message to every subscription; drops subscriptions the push service rejects as gone. */
  async notify(message: PushMessage): Promise<number> {
    if (this.subscriptions.length === 0) return 0;
    const payload = JSON.stringify(message);
    let sent = 0;
    const gone: string[] = [];
    await Promise.all(
      this.subscriptions.map(async (subscription) => {
        try {
          await webpush.sendNotification(subscription, payload, {
            TTL: 3600,
            urgency: message.kind === "turn" ? "normal" : "high",
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

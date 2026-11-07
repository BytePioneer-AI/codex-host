import { AsyncLocalStorage } from "node:async_hooks";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Agent } from "node:https";
import { setTimeout as sleep } from "node:timers/promises";
import * as acme from "acme-client";
import type { DataDir } from "../store.ts";
import type { RelayTls } from "./tls.ts";

export interface AcmeProblem {
  type?: string;
  detail?: string;
}
export interface AcmeResponseFailure extends AcmeProblem {
  status: number;
  retryAfter?: number | undefined;
}

export class AcmeFailure extends Error {
  constructor(
    readonly kind: "caa" | "validation" | "other",
    readonly problem?: AcmeProblem,
  ) {
    super(problem?.detail ?? "The certificate authority could not be reached");
  }
}

export function classifyFailure(problem?: AcmeProblem, invalidAuthorization = false): AcmeFailure {
  return new AcmeFailure(
    problem?.type === "urn:ietf:params:acme:error:caa"
      ? "caa"
      : invalidAuthorization
        ? "validation"
        : "other",
    problem,
  );
}

export function acmeDirectory(): string {
  return process.env.CODEXHOST_RELAY_ACME_DIRECTORY ?? acme.directory.letsencrypt.production;
}

export function certificateKey(
  data: DataDir,
  name: "acme-account.pem" | "certificate-key.pem",
): Buffer {
  const file = data.path("remote-relay", name);
  if (!existsSync(file)) {
    mkdirSync(data.path("remote-relay"), { recursive: true });
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    try {
      writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }), {
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return readFileSync(file);
}

let sequence = 0;
export class AcmeRound {
  readonly id = ++sequence;
  readonly controller = new AbortController();
  responseFailure: AcmeResponseFailure | undefined;
  retryAfter: number | undefined;
  private readonly deadline = setTimeout(() => this.stop(), 10 * 60_000);
  private challengeInstalled = false;

  constructor(private readonly tls: RelayTls) {}

  assertActive(): void {
    this.controller.signal.throwIfAborted();
  }

  setChallenge(hostname: string, cert: Buffer, key: Buffer): void {
    this.assertActive();
    this.tls.setChallenge(hostname, cert, key);
    this.challengeInstalled = true;
  }

  stop(): void {
    clearTimeout(this.deadline);
    this.controller.abort();
    if (this.challengeInstalled) {
      this.tls.clearChallenge();
      this.challengeInstalled = false;
    }
  }

  async wait(): Promise<void> {
    this.assertActive();
    await sleep(Math.max(0, (this.retryAfter ?? Date.now() + 2_000) - Date.now()), undefined, {
      signal: this.controller.signal,
    });
    this.assertActive();
  }
}

const rounds = new AsyncLocalStorage<AcmeRound>();
const requests = new WeakMap<object, AcmeRound>();
(
  acme.axios.defaults as typeof acme.axios.defaults & { acmeSettings: { retryMaxAttempts: number } }
).acmeSettings.retryMaxAttempts = 0;
acme.axios.defaults.timeout = 30_000;
// Allow slower IPv4 connections to finish before falling back to a possibly unavailable IPv6 route.
acme.axios.defaults.httpsAgent = new Agent({
  keepAlive: true,
  autoSelectFamilyAttemptTimeout: 2_000,
});
acme.axios.interceptors.request.use((config) => {
  const round = rounds.getStore();
  if (round) {
    round.assertActive();
    requests.set(config, round);
  }
  return config;
});
acme.axios.interceptors.response.use((response) => {
  const round = requests.get(response.config);
  if (round) {
    const header = response.headers["retry-after"] as string | undefined;
    round.retryAfter =
      header === undefined
        ? undefined
        : /^\d+$/.test(header)
          ? Date.now() + Number(header) * 1_000
          : Date.parse(header);
    round.responseFailure =
      response.status >= 200 && response.status < 300
        ? undefined
        : {
            status: response.status,
            type: response.data?.type,
            detail: response.data?.detail,
            retryAfter: round.retryAfter,
          };
  }
  return response;
});

/** One order, with all HTTP requests (including library nonce requests) bound to its round. */
export async function issueCertificate(
  round: AcmeRound,
  data: DataDir,
  hostname: string,
  directory: string,
  validated: () => void,
): Promise<string> {
  return rounds.run(round, async () => {
    round.assertActive();
    const client = new acme.Client({
      directoryUrl: directory,
      accountKey: certificateKey(data, "acme-account.pem"),
    });
    const key = certificateKey(data, "certificate-key.pem");
    try {
      await client.createAccount({ onlyReturnExisting: true });
    } catch (error) {
      round.assertActive();
      if (round.responseFailure?.type !== "urn:ietf:params:acme:error:accountDoesNotExist")
        throw error;
      await client.createAccount({ termsOfServiceAgreed: true });
    }
    round.assertActive();
    let order = await client.createOrder({ identifiers: [{ type: "dns", value: hostname }] });
    round.assertActive();
    // Each order has one DNS identifier; keep authorization requests sequential as well.
    for (const url of order.authorizations) {
      let authz = (
        await client.getAuthorizations({ ...order, authorizations: [url] })
      )[0] as acme.Authorization;
      round.assertActive();
      if (authz.status === "pending") {
        const challenge = authz.challenges.find(
          (value) => String(value.type) === "tls-alpn-01",
        ) as acme.Authorization["challenges"][number];
        const authorization = await client.getChallengeKeyAuthorization(challenge);
        round.assertActive();
        const challengeKey = await acme.crypto.createPrivateEcdsaKey("P-256");
        round.assertActive();
        const [, cert] = await acme.crypto.createAlpnCertificate(
          authz,
          authorization,
          challengeKey,
        );
        round.setChallenge(hostname, cert, challengeKey);
        await client.completeChallenge(challenge);
        round.assertActive();
      }
      while (authz.status !== "valid") {
        if (authz.status === "invalid") {
          throw classifyFailure(authz.challenges.find((challenge) => challenge.error)?.error, true);
        }
        await round.wait();
        authz = (
          await client.getAuthorizations({ ...order, authorizations: [url] })
        )[0] as acme.Authorization;
        round.assertActive();
      }
    }
    validated();
    const [, csr] = await acme.crypto.createCsr({ altNames: [hostname] }, key);
    round.assertActive();
    order = await client.finalizeOrder(order, csr);
    round.assertActive();
    while (order.status !== "valid") {
      if (order.status === "invalid") throw classifyFailure(order.error);
      await round.wait();
      order = await client.getOrder(order);
      round.assertActive();
    }
    const certificate = await client.getCertificate(order);
    round.assertActive();
    return certificate;
  });
}

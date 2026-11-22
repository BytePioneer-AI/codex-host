import { createPrivateKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { Agent } from "node:https";
import { join } from "node:path";
import { createServer, type Server } from "node:tls";
import * as acme from "acme-client";

const checkInterval = 15 * 60_000;
// Retry on the next scheduled check, not in the HTTP client's retry loop.
(
  acme.axios.defaults as typeof acme.axios.defaults & {
    acmeSettings: { retryMaxAttempts: number };
  }
).acmeSettings.retryMaxAttempts = 0;
acme.axios.defaults.timeout = 30_000;
// Allow slower IPv4 connections to finish before falling back to a possibly unavailable IPv6 route.
acme.axios.defaults.httpsAgent = new Agent({
  keepAlive: true,
  autoSelectFamilyAttemptTimeout: 2_000,
});

export class ControlCertificate {
  readonly challenge = createServer({ ALPNProtocols: ["acme-tls/1"] }, (socket) => socket.end());
  private challengeReady = false;
  private certificate: X509Certificate | undefined;
  private timer: NodeJS.Timeout | undefined;
  private pending: Promise<void> | undefined;
  private stopped = false;
  private readonly key: Buffer;

  constructor(
    private readonly tls: Server,
    private readonly hostname: string,
    private readonly dataDir: string,
    private readonly directory = process.env.CODEXHOST_RELAY_ACME_DIRECTORY ??
      acme.directory.letsencrypt.production,
  ) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.key = this.privateKey("certificate-key.pem");
    this.challenge.on("tlsClientError", (_error, socket) => socket.destroy());
    const certificateFile = join(dataDir, "certificate.pem");
    if (existsSync(certificateFile)) {
      try {
        this.install(readFileSync(certificateFile));
      } catch {
        // A damaged or mismatched stored certificate must be replaced before serving TLS.
      }
    }
  }

  get available(): boolean {
    return this.certificate !== undefined && Date.now() < Date.parse(this.certificate.validTo);
  }

  get verifying(): boolean {
    return this.challengeReady;
  }

  start(): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), checkInterval);
    this.timer.unref();
  }

  check(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.stopped) return Promise.resolve();
    if (this.available && this.certificate) {
      const from = Date.parse(this.certificate.validFrom);
      if (Date.now() < from + ((Date.parse(this.certificate.validTo) - from) * 2) / 3)
        return Promise.resolve();
    }
    this.pending = this.issue()
      .catch((error: unknown) => console.error("Control certificate issuance failed:", error))
      .finally(() => {
        this.challengeReady = false;
        this.pending = undefined;
      });
    return this.pending;
  }

  stop(): void {
    this.stopped = true;
    this.challengeReady = false;
    clearInterval(this.timer);
  }

  private privateKey(name: string): Buffer {
    const file = join(this.dataDir, name);
    if (!existsSync(file)) {
      const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), {
        mode: 0o600,
        flag: "wx",
      });
    }
    return readFileSync(file);
  }

  private install(cert: Buffer): void {
    const certificate = new X509Certificate(cert);
    if (
      !certificate.checkHost(this.hostname) ||
      !certificate.checkPrivateKey(createPrivateKey(this.key)) ||
      Date.now() < Date.parse(certificate.validFrom) ||
      Date.now() >= Date.parse(certificate.validTo)
    ) {
      throw new Error("Unusable control certificate");
    }
    this.tls.setSecureContext({ cert, key: this.key });
    this.certificate = certificate;
  }

  private async issue(): Promise<void> {
    const client = new acme.Client({
      directoryUrl: this.directory,
      accountKey: this.privateKey("acme-account.pem"),
    });
    const [, csr] = await acme.crypto.createCsr({ altNames: [this.hostname] }, this.key);
    if (this.stopped) return;
    const cert = await client.auto({
      csr,
      termsOfServiceAgreed: true,
      challengePriority: ["tls-alpn-01"],
      skipChallengeVerification: true,
      challengeCreateFn: async (authz, challenge, authorization) => {
        if (String(challenge.type) !== "tls-alpn-01") throw new Error("TLS-ALPN-01 is required");
        const [key, cert] = await acme.crypto.createAlpnCertificate(authz, authorization);
        if (this.stopped) throw new Error("Control certificate manager stopped");
        this.challenge.setSecureContext({ cert, key });
        this.challengeReady = true;
      },
      challengeRemoveFn: async () => {
        this.challengeReady = false;
      },
    });
    if (this.stopped) return;
    this.install(Buffer.from(cert));
    const file = join(this.dataDir, "certificate.pem");
    writeFileSync(`${file}.tmp`, cert, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
}

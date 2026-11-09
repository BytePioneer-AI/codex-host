import { createPrivateKey, X509Certificate } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createSecureContext, type SecureContext } from "node:tls";
import type { DataDir } from "../store.ts";
import type { WebRelayCertificate } from "@codexhost/shared-contracts";
import {
  AcmeFailure,
  AcmeRound,
  acmeDirectory,
  classifyFailure,
  issueCertificate,
} from "./acme.ts";
import type { RelayTls } from "./tls.ts";

const hour = 60 * 60_000;

export interface CertificateRecord {
  hostname: string;
  directory: string;
  failures: number;
  validationFailures: number;
  retryAt: number;
  retryAfter?: number;
  paused?: boolean;
  detail?: string | undefined;
}

export interface UsableCertificate {
  notBefore: number;
  notAfter: number;
  context: SecureContext;
}

/** The same acceptance rule applies to disk contents and newly issued certificates. */
export function usableCertificate(
  cert: string | Buffer,
  key: Buffer,
  hostname: string,
  now: number,
): UsableCertificate | undefined {
  try {
    const x509 = new X509Certificate(cert);
    const notBefore = Date.parse(x509.validFrom);
    const notAfter = Date.parse(x509.validTo);
    if (
      !x509.checkHost(hostname.toLowerCase()) ||
      now < notBefore ||
      now >= notAfter ||
      !x509.checkPrivateKey(createPrivateKey(key))
    )
      return;
    return { notBefore, notAfter, context: createSecureContext({ cert, key }) };
  } catch {
    return;
  }
}

/** Undefined means paused; otherwise the result is the earliest time to issue. */
export function nextAction(
  now: number,
  certificate: UsableCertificate | undefined,
  record: CertificateRecord | undefined,
): number | undefined {
  if (record?.paused) return;
  const renewAt = certificate
    ? certificate.notBefore + ((certificate.notAfter - certificate.notBefore) * 2) / 3
    : now;
  return Math.max(now, renewAt, record?.retryAt ?? 0);
}

export function retryDelay(failures: number, random: number): number {
  const base =
    failures === 1 ? 10 * 60_000 : failures === 2 ? hour : failures === 3 ? 6 * hour : 24 * hour;
  return base * (1 + random * 0.1);
}

/** Only a registered Web process checks certificates and writes issuance records. */
export class Certificates {
  private hostname: string | undefined;
  private endpoint = "";
  private readonly directory = acmeDirectory();
  private reset: "restart" | "enable" | undefined = "restart";
  private record: CertificateRecord | undefined;
  private certificate: UsableCertificate | undefined;
  private round: AcmeRound | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly data: DataDir,
    private readonly tls: RelayTls,
    private readonly changed: () => void,
    private readonly now = Date.now,
    private readonly random = Math.random,
  ) {}

  get state(): WebRelayCertificate {
    return {
      ...(this.certificate ? { expiresAt: new Date(this.certificate.notAfter).toISOString() } : {}),
      issuing: this.round !== undefined,
      ...(!this.round && this.record
        ? {
            failure: {
              ...(this.record.detail ? { detail: this.record.detail } : {}),
              retryAt: new Date(this.record.retryAt).toISOString(),
              paused: this.record.paused ?? false,
            },
          }
        : {}),
    };
  }

  enable(): void {
    this.reset = "enable";
  }

  start(hostname: string, host: string): void {
    this.stop();
    this.endpoint = `remote-relay/endpoints/${encodeURIComponent(host)}`;
    this.hostname = hostname;
    this.check();
  }

  stop(): void {
    clearTimeout(this.timer);
    this.round?.stop();
    this.round = undefined;
    this.hostname = undefined;
    this.certificate = undefined;
    this.tls.clear();
  }

  private readRecord(): CertificateRecord | undefined {
    const record = this.data.readJson<CertificateRecord | undefined>(
      `${this.endpoint}/certificate-state.json`,
      undefined,
    );
    return record && record.hostname === this.hostname && record.directory === this.directory
      ? record
      : undefined;
  }

  private save(record: CertificateRecord): void {
    const existing = this.readRecord();
    const retryAfter = Math.max(existing?.retryAfter ?? 0, record.retryAfter ?? 0);
    this.record = {
      ...record,
      retryAt: Math.max(existing?.retryAt ?? 0, record.retryAt, retryAfter),
      ...(retryAfter ? { retryAfter } : {}),
    };
    this.data.writeJson(`${this.endpoint}/certificate-state.json`, this.record, { mode: 0o600 });
  }

  private load(): UsableCertificate | undefined {
    try {
      return usableCertificate(
        readFileSync(this.data.path(this.endpoint, "certificate.pem")),
        readFileSync(this.data.path("remote-relay/certificate-key.pem")),
        this.hostname as string,
        this.now(),
      );
    } catch {
      return;
    }
  }

  check(): void {
    if (this.hostname === undefined) return;
    clearTimeout(this.timer);
    this.certificate = this.load();
    if (this.certificate) this.tls.useCertificate(this.certificate.context);
    else this.tls.clear();
    this.record = this.readRecord();
    if (this.reset) {
      if (this.record) {
        delete this.record.paused;
        if (this.reset === "enable") {
          this.record.failures = 0;
          this.record.validationFailures = 0;
          this.record.retryAt = this.record.retryAfter ?? 0;
        }
        // Explicit user reset is the only operation allowed to shorten local backoff.
        this.data.writeJson(`${this.endpoint}/certificate-state.json`, this.record, {
          mode: 0o600,
        });
      }
      this.reset = undefined;
    }
    const action = nextAction(this.now(), this.certificate, this.record);
    if (!this.round && action !== undefined && action <= this.now()) {
      const round = new AcmeRound(this.tls);
      this.round = round;
      void this.issue(round, this.hostname).finally(() => {
        if (this.round === round) {
          this.round = undefined;
          this.schedule();
          this.changed();
        }
      });
    }
    this.schedule();
    this.changed();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.hostname === undefined) return;
    const now = this.now();
    const action = this.round ? undefined : nextAction(now, this.certificate, this.record);
    const at = Math.min(now + hour, this.certificate?.notAfter ?? Infinity, action ?? Infinity);
    this.timer = setTimeout(
      () => {
        try {
          this.check();
        } catch {
          this.stop();
          this.changed();
        }
      },
      Math.max(0, at - now),
    );
  }

  private async issue(round: AcmeRound, hostname: string): Promise<void> {
    try {
      const failures = (this.record?.failures ?? 0) + 1;
      this.save({
        ...this.record,
        hostname,
        directory: this.directory,
        failures,
        validationFailures: this.record?.validationFailures ?? 0,
        retryAt: this.now() + retryDelay(failures, this.random()),
        detail: undefined,
      });
      const cert = await issueCertificate(round, this.data, hostname, this.directory, () => {
        this.save({ ...(this.record as CertificateRecord), validationFailures: 0 });
      });
      round.assertActive();
      const certificate = usableCertificate(
        cert,
        readFileSync(this.data.path("remote-relay/certificate-key.pem")),
        hostname,
        this.now(),
      );
      if (!certificate) throw new Error("Unusable certificate");
      const target = this.data.path(this.endpoint, "certificate.pem");
      const temp = `${target}.${process.pid}.${round.id}.tmp`;
      writeFileSync(temp, cert, { mode: 0o600 });
      renameSync(temp, target);
      this.tls.useCertificate(certificate.context);
      this.certificate = certificate;
      rmSync(this.data.path(this.endpoint, "certificate-state.json"), { force: true });
      this.record = undefined;
    } catch (error) {
      if (!round.controller.signal.aborted) {
        const failure =
          error instanceof AcmeFailure ? error : classifyFailure(round.responseFailure);
        const validationFailures =
          (this.record?.validationFailures ?? 0) + (failure.kind === "validation" ? 1 : 0);
        const record = this.record as CertificateRecord;
        try {
          this.save({
            ...record,
            validationFailures,
            paused:
              failure.kind === "caa" || (failure.kind === "validation" && validationFailures >= 2),
            detail: failure.problem?.detail,
            ...(round.responseFailure?.retryAfter === undefined
              ? {}
              : { retryAfter: round.responseFailure.retryAfter }),
          });
        } catch {
          // Keep the in-memory backoff and usable TLS context if the failure record cannot be written.
        }
      }
    } finally {
      round.stop();
    }
  }
}

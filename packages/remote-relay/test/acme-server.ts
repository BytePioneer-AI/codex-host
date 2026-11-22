import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import * as acme from "acme-client";
import { phone } from "./helpers.js";

/** Local ACME protocol responses with real JWS requests, CSR signing and a TLS-ALPN probe. */
export async function acmeServer(data: string, hostname: string, relayPort: () => number) {
  let url = "";
  let status = "pending";
  let certificate = "";
  let orders = 0;
  let validations = 0;
  let failure = false;
  let probeError: unknown;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const encoded = body ? JSON.parse(body).payload : "";
    const payload = encoded ? JSON.parse(Buffer.from(encoded, "base64url").toString()) : null;
    const reply = (code: number, data: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(code, {
        "content-type": "application/json",
        "replay-nonce": "nonce",
        ...headers,
      });
      response.end(typeof data === "string" ? data : JSON.stringify(data));
    };
    const order = {
      status: certificate ? "valid" : "ready",
      authorizations: [`${url}/authz`],
      finalize: `${url}/finalize`,
      certificate: `${url}/certificate`,
    };
    const challenge = { type: "tls-alpn-01", token: "test-token", url: `${url}/challenge`, status };
    try {
      switch (request.url) {
        case "/dir":
          reply(200, {
            newNonce: `${url}/nonce`,
            newAccount: `${url}/account`,
            newOrder: `${url}/order`,
          });
          break;
        case "/nonce":
          reply(200, "");
          break;
        case "/account":
          reply(200, { status: "valid" }, { location: `${url}/account/1` });
          break;
        case "/account/1":
          reply(200, { status: "valid" });
          break;
        case "/order":
          orders++;
          status = "pending";
          certificate = "";
          if (failure) reply(503, { detail: "local CA unavailable" });
          else reply(201, order, { location: `${url}/order/1` });
          break;
        case "/authz":
          reply(200, {
            status,
            identifier: { type: "dns", value: hostname },
            challenges: [challenge],
          });
          break;
        case "/challenge": {
          if (payload) {
            const client = new acme.Client({
              directoryUrl: `${url}/dir`,
              accountKey: readFileSync(join(data, "acme-account.pem")),
            });
            const authorization = await client.getChallengeKeyAuthorization(
              challenge as acme.Authorization["challenges"][number],
            );
            const socket = phone(hostname, ["acme-tls/1"], relayPort());
            try {
              await once(socket, "secureConnect");
              if (socket.alpnProtocol !== "acme-tls/1") throw new Error("Wrong ALPN");
              const pem = `-----BEGIN CERTIFICATE-----\n${socket.getPeerCertificate().raw.toString("base64")}\n-----END CERTIFICATE-----`;
              if (!acme.crypto.isAlpnCertificateAuthorizationValid(pem, authorization))
                throw new Error("Invalid ALPN authorization certificate");
              validations++;
              status = "valid";
            } finally {
              socket.destroy();
            }
          }
          reply(200, { ...challenge, status });
          break;
        }
        case "/finalize": {
          const csr = Buffer.from(payload.csr, "base64url");
          const pem = `-----BEGIN CERTIFICATE REQUEST-----\n${csr.toString("base64")}\n-----END CERTIFICATE REQUEST-----`;
          certificate = signCertificate(data, pem, 90);
          reply(200, { ...order, status: "valid" });
          break;
        }
        case "/order/1":
          reply(200, order);
          break;
        case "/certificate":
          reply(200, certificate, { "content-type": "application/pem-certificate-chain" });
          break;
        default:
          reply(404, {});
      }
    } catch (error) {
      probeError = error;
      reply(500, { detail: String(error) });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    directory: `${url}/dir`,
    get orders() {
      return orders;
    },
    get validations() {
      return validations;
    },
    get probeError() {
      return probeError;
    },
    fail() {
      failure = true;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function signCertificate(data: string, csr: Buffer | string, days: number): string {
  writeFileSync(join(data, "test.csr"), csr);
  return execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      join(data, "test.csr"),
      "-signkey",
      join(data, "certificate-key.pem"),
      "-days",
      String(days),
      "-extfile",
      join(data, "test-ext.cnf"),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  ).toString();
}

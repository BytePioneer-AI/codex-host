import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Agent, createServer } from "node:https";
import type { TestContext } from "node:test";
import * as acme from "acme-client";
import { credentials } from "./relay.ts";
import { environment } from "./pebble.ts";

export interface AcmeRequest {
  path: string;
  payload: Record<string, unknown> | null;
  request: IncomingMessage;
  response: ServerResponse;
  reply(status: number, data: unknown, headers?: Record<string, string>): void;
}

/** Local ACME responses, with real JWS requests and HTTP status/Retry-After handling. */
export async function acmeServer(
  t: TestContext,
  handle: (request: AcmeRequest) => boolean = () => false,
) {
  const requests: AcmeRequest[] = [];
  let url = "";
  const server = createServer(credentials, async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const encoded = body ? JSON.parse(body).payload : "";
    const payload = encoded ? JSON.parse(Buffer.from(encoded, "base64url").toString()) : null;
    const reply = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "replay-nonce": "nonce",
        ...headers,
      });
      response.end(typeof data === "string" ? data : JSON.stringify(data));
    };
    const item = { path: request.url as string, payload, request, response, reply };
    requests.push(item);
    if (handle(item)) return;
    const order = {
      status: "valid",
      authorizations: [`${url}/authz`],
      finalize: `${url}/finalize`,
      certificate: `${url}/certificate`,
    };
    switch (item.path) {
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
        reply(
          payload?.termsOfServiceAgreed ? 201 : 200,
          { status: "valid" },
          { location: `${url}/account/1` },
        );
        break;
      case "/account/1":
        reply(200, { status: "valid" });
        break;
      case "/order":
        reply(201, order, { location: `${url}/order/1` });
        break;
      case "/authz":
        reply(200, {
          status: "valid",
          identifier: { type: "dns", value: "phone.relay.test" },
          challenges: [],
        });
        break;
      case "/finalize":
      case "/order/1":
        reply(200, order);
        break;
      case "/certificate":
        reply(200, credentials.cert.toString(), {
          "content-type": "application/pem-certificate-chain",
        });
        break;
      default:
        reply(404, {});
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `https://localhost:${(server.address() as { port: number }).port}`;
  environment(t, {
    CODEXHOST_RELAY_ACME_DIRECTORY: `${url}/dir`,
    HTTPS_PROXY: "",
    https_proxy: "",
    ALL_PROXY: "",
    all_proxy: "",
  });
  const previous = acme.axios.defaults.httpsAgent;
  const agent = new Agent({ ca: credentials.cert });
  acme.axios.defaults.httpsAgent = agent;
  t.after(async () => {
    acme.axios.defaults.httpsAgent = previous;
    agent.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { requests, url, directory: `${url}/dir` };
}

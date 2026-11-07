#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createRelay } from "./index.js";
import { selfHostedNames } from "./names.js";

const { values } = parseArgs({
  options: {
    domain: { type: "string" },
    "control-host": { type: "string" },
    cert: { type: "string" },
    key: { type: "string" },
    "data-dir": { type: "string", default: process.env.CODEXHOST_RELAY_DATA_DIR ?? "./data" },
    port: { type: "string", default: "443" },
    rate: { type: "string" },
    "daily-quota": { type: "string" },
    "max-connections": { type: "string" },
  },
});
if (!values.domain) {
  throw new Error("--domain is required");
}
const relay = createRelay({
  domain: values.domain,
  ...(values["control-host"] === undefined ? {} : { controlHost: values["control-host"] }),
  ...(values.cert === undefined ? {} : { cert: values.cert }),
  ...(values.key === undefined ? {} : { key: values.key }),
  dataDir: values["data-dir"],
  check: selfHostedNames(
    values["data-dir"],
    values.domain,
    values["control-host"] ?? `relay.${values.domain}`,
  ),
  ...(values.rate === undefined ? {} : { rate: Number(values.rate) }),
  ...(values["daily-quota"] === undefined ? {} : { dailyQuota: Number(values["daily-quota"]) }),
  ...(values["max-connections"] === undefined
    ? {}
    : { maxConnections: Number(values["max-connections"]) }),
});
relay.server.listen(Number(values.port));

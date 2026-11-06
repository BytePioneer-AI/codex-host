#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createRelay } from "./index.js";

const { values } = parseArgs({
  options: {
    domain: { type: "string" },
    "control-host": { type: "string" },
    cert: { type: "string" },
    key: { type: "string" },
    port: { type: "string", default: "443" },
    rate: { type: "string" },
    "daily-quota": { type: "string" },
  },
});
if (!values.domain || !values.cert || !values.key) {
  throw new Error("--domain, --cert and --key are required");
}
const relay = createRelay({
  domain: values.domain,
  controlHost: values["control-host"] ?? values.domain,
  cert: values.cert,
  key: values.key,
  ...(values.rate === undefined ? {} : { rate: Number(values.rate) }),
  ...(values["daily-quota"] === undefined ? {} : { dailyQuota: Number(values["daily-quota"]) }),
});
relay.server.listen(Number(values.port));

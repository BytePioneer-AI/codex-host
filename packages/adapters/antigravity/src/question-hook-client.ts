// Embedded so the single-file release bundle needs no additional runtime assets.
export const ANTIGRAVITY_QUESTION_HOOK_CLIENT = String.raw`
const http = require("node:http");
const limit = 131072;
let input = "";
let finished = false;
let request;
function finish(value) {
  if (finished) return;
  finished = true;
  process.stdout.write(JSON.stringify(value));
}
function unavailable() {
  finish({
    decision: "deny",
    reason: "codexhost question bridge is unavailable. No user answer was received. Do not report that the user skipped or selected an option."
  });
  if (request) request.destroy();
}
process.stdin.setEncoding("utf8");
process.stdin.on("error", unavailable);
process.stdin.on("data", chunk => {
  input += chunk;
  if (Buffer.byteLength(input) > limit) {
    input = "";
    process.stdin.destroy();
    unavailable();
  }
});
process.stdin.on("end", () => {
  if (finished) return;
  try {
    const target = new URL(process.env.CODEXHOST_AGY_QUESTION_URL);
    if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" ||
        target.pathname !== "/question" || target.username || target.password) {
      return unavailable();
    }
    JSON.parse(input);
    request = http.request(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + process.env.CODEXHOST_AGY_QUESTION_TOKEN,
        "content-length": Buffer.byteLength(input)
      }
    }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("error", unavailable);
      response.on("aborted", unavailable);
      response.on("data", chunk => {
        body += chunk;
        if (Buffer.byteLength(body) > limit) unavailable();
      });
      response.on("end", () => {
        try {
          const value = JSON.parse(body);
          if (response.statusCode !== 200 || value.decision !== "deny" ||
              typeof value.reason !== "string") return unavailable();
          finish(value);
        } catch { unavailable(); }
      });
    });
    request.setTimeout(Number(process.env.CODEXHOST_AGY_QUESTION_TIMEOUT_MS) + 5000, unavailable);
    request.on("error", unavailable);
    request.end(input);
  } catch { unavailable(); }
});
`;

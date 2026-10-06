// Deterministic loopback model. The CLI and code-mode helper still execute real tools.
import http from "node:http";
import assert from "node:assert/strict";

export async function startNativeToolModel() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/responses") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    const ordinal = requests.length;
    const item =
      ordinal % 2 === 1
        ? {
            type: "custom_tool_call",
            call_id: `native-tool-${ordinal}`,
            name: "exec",
            input:
              "text(await tools.exec_command({cmd: 'printf CODE_MODE_NATIVE_OK | rg CODE_MODE_NATIVE_OK && command -v rg', login: false, max_output_tokens: 256}));",
          }
        : {
            type: "message",
            role: "assistant",
            id: `native-answer-${ordinal}`,
            content: [{ type: "output_text", text: "Native tool acceptance complete" }],
          };
    const events = [
      { type: "response.created", response: { id: `native-response-${ordinal}` } },
      { type: "response.output_item.done", item },
      {
        type: "response.completed",
        response: {
          id: `native-response-${ordinal}`,
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
      },
    ];
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    verify(expectedSearchPath) {
      assert.equal(requests.length, 2, "One tool execution and one model follow-up expected");
      const output = requests[1].input.find((item) => item.type === "custom_tool_call_output");
      assert(output, "Code-mode execution must return a tool result to the model");
      assert(JSON.stringify(output.output).includes("CODE_MODE_NATIVE_OK"), JSON.stringify(output));
      assert(!JSON.stringify(output.output).includes("failed to spawn"));
      if (expectedSearchPath)
        assert(JSON.stringify(output.output).includes(expectedSearchPath), JSON.stringify(output));
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

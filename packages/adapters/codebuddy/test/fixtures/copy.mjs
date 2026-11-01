const args = process.argv.slice(2);
const id = args[args.indexOf("--session-id") + 1];
const mode = process.env.COPY_TEST_MODE;
let input = "";
process.stdin.on("data", (data) => (input += data));
process.stdin.on("end", () => {
  if (input || !args.includes("--fork-session") || args.includes("/fork") || args.includes("--acp"))
    process.exit(2);
  if (mode === "hang") {
    setInterval(() => {}, 100);
    return;
  }
  if (mode === "exit") process.exit(3);
  if (mode === "invalid") {
    process.stdout.write("not-json");
    return;
  }
  process.stdout.write(
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: mode === "identity" ? "source" : id,
    }) + "\n",
  );
  process.stdout.write(
    JSON.stringify({
      type: "result",
      is_error: false,
      session_id: id,
      duration_api_ms: mode === "model" ? 10 : 0,
      usage: { input_tokens: mode === "usage" ? 1 : 0, output_tokens: 0 },
    }) + "\n",
  );
});

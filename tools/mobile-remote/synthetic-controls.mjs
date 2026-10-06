/** Test-only controls for the Fake Harness owned by phone-probe. */
export async function syntheticControl(host, command) {
  if (!host) throw new Error("Synthetic Host is not ready");
  if (command === "reply") {
    const session = host.adapter.sessions[0];
    if (!session) throw new Error("Synthetic session is missing");
    session.appendText("手机双向通信验证成功：本地合成 Harness 已收到消息并返回这条回复。");
    session.succeedTurn();
  } else if (command !== "status") {
    throw new Error("Expected status, reply, or stop");
  }
  const result = await host.desktop.request("thread/read", {
    threadId: host.threadId,
    includeTurns: true,
  });
  return { threadId: result.thread.id, turns: result.thread.turns };
}

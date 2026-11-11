/** Match the Desktop AskQuestionFeatureService settings and its CN experiment fallback. */
async function desktopRequestSettings(vscode) {
  const configuration = vscode.workspace.getConfiguration();
  const override = configuration.get("AI.agent.v2.askUserQuestion.featureOverride");
  const forced =
    override === "force_enabled" ? true : override === "force_disabled" ? false : undefined;
  let available = forced;
  if (available === undefined) {
    try {
      // The command returning all variables exposes the same Tea values to the
      // extension host. Keep only this feature's boolean, never its experiment ID.
      const variables = await vscode.commands.executeCommand("icube.event.getAllABTestConfigs");
      const enabled = variables?.ask_user_question_v2?.val?.enabled;
      available = typeof enabled === "boolean" ? enabled : true;
    } catch {
      available = true;
    }
  }
  return {
    ask_question_config: {
      feature_available: available,
      ide_enable: forced ?? configuration.get("AI.agent.v2.ide.proactiveQuestioning") === true,
      solo_enable: forced ?? configuration.get("AI.agent.v2.solo.proactiveQuestioning") === true,
    },
  };
}

/** Same fallback and flags as the Desktop ForkChatService. No settings writes. */
async function desktopHistorySettings(vscode) {
  const defaults = {
    enable_v2: true,
    enable_create_from_message: true,
    enable_create_from_session: true,
  };
  let config = defaults;
  try {
    const values = await vscode.commands.executeCommand("icube.event.getAllABTestConfigs");
    config = values?.fork_chat?.val ?? defaults;
  } catch {
    /* Desktop's native fallback permits the feature when config cannot be read. */
  }
  return {
    forkFromMessage: config.enable_v2 === true && config.enable_create_from_message === true,
    forkFromSession: config.enable_v2 === true && config.enable_create_from_session === true,
  };
}

async function desktopModelSettings(vscode) {
  const user = await vscode.commands.executeCommand("icube.common.getUserInfo");
  if (!user?.token)
    throw Object.assign(new Error("Sign in to TRAE CN Desktop"), {
      code: "authenticationRequired",
    });
  // Only this account-policy boolean leaves the credential-owning app process.
  return { internal: user.account?.scope === "bytedance" };
}

function desktopNativeAgent(vscode) {
  const selected = vscode.workspace.getConfiguration().get("codexhost.traeCn.nativeAgent");
  if (selected === undefined) return "builder_v3";
  if (selected === "builder_v3" || selected === "solo_agent") return selected;
  throw Object.assign(new Error("Select Builder or SOLO Agent in CodexHost TRAE CN settings"), {
    code: "configurationRequired",
  });
}

module.exports = {
  desktopRequestSettings,
  desktopHistorySettings,
  desktopModelSettings,
  desktopNativeAgent,
};

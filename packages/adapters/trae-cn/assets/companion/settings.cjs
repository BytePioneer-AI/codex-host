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

module.exports = { desktopRequestSettings };

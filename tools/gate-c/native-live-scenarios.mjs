import {
  contextFromCapture,
  runForkScenario,
  runHistoryScenario,
  runModelSwitchScenario,
  runNativeAppendScenario,
  runStreamScenario,
  runTreeBranchScenario,
} from "./native-live-core.mjs";
import { runRuntimeEdgeScenario } from "./native-live-edges.mjs";
import {
  runCancelHistoryScenario,
  runCancelScenario,
  runQuestionScenario,
  runToolScenario,
} from "./native-live-tools.mjs";

export async function runNativeLiveProfile({ repositoryRoot, workspace, configuredCommand }) {
  const results = [];

  const stream = await runStreamScenario({ repositoryRoot, workspace, configuredCommand });
  results.push(stream);

  let sourceContext;
  if (stream.result.status === "PASS") {
    const streamContext = contextFromCapture(stream.outputPath);
    const modelSwitch = await runModelSwitchScenario({
      repositoryRoot,
      workspace,
      configuredCommand,
      sessionFile: streamContext.sessionFile,
    });
    results.push(modelSwitch);
    sourceContext = contextFromCapture(modelSwitch.outputPath);

    const history = await runHistoryScenario({
      repositoryRoot,
      workspace,
      configuredCommand,
      sessionFile: sourceContext.sessionFile,
      originalUserIds: sourceContext.userIds,
    });
    results.push(history);
    if (history.result.status === "PASS") {
      const historyContext = contextFromCapture(history.outputPath);
      const nativeAppend = await runNativeAppendScenario({
        repositoryRoot,
        workspace,
        configuredCommand,
        sessionFile: historyContext.sessionFile,
        expectedUserIds: historyContext.userIds,
      });
      results.push(nativeAppend);
      const forkContext =
        nativeAppend.result.status === "PASS"
          ? contextFromCapture(nativeAppend.outputPath)
          : historyContext;
      const fork = await runForkScenario({
        repositoryRoot,
        workspace,
        configuredCommand,
        sessionFile: forkContext.sessionFile,
      });
      results.push(fork);
      if (fork.result.status === "PASS") {
        results.push(
          await runTreeBranchScenario({
            repositoryRoot,
            workspace,
            configuredCommand,
            sessionFile: forkContext.sessionFile,
          }),
        );
      }
    }
  }

  results.push(
    await runToolScenario({ repositoryRoot, workspace, configuredCommand }),
    await runQuestionScenario({ repositoryRoot, workspace, configuredCommand }),
  );
  const cancel = await runCancelScenario({ repositoryRoot, workspace, configuredCommand });
  results.push(cancel);
  if (cancel.result.status === "PASS") {
    const cancelContext = contextFromCapture(cancel.outputPath);
    results.push(
      await runCancelHistoryScenario({
        repositoryRoot,
        workspace,
        configuredCommand,
        sessionFile: cancelContext.sessionFile,
        expectedUserIds: cancelContext.userIds,
      }),
    );
  }
  results.push(await runRuntimeEdgeScenario({ repositoryRoot, workspace, configuredCommand }));

  return results;
}

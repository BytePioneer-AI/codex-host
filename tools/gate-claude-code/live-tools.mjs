import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { scenarioResult, scenarioStatus } from "./contracts.mjs";
import {
  collectQuery,
  nativeToolResults,
  nativeToolUses,
  writeRawScenario,
} from "./live-helpers.mjs";
import { verifyStructuredPatch } from "./patch.mjs";
import { claudeOptions } from "./runtime.mjs";
import { createProbeWorkspace, removeSyntheticProject } from "./workspace.mjs";

function successful(summary) {
  return summary.resultCount === 1 && summary.terminal.outcome === "succeeded";
}

export async function runToolEditScenario({ repositoryRoot, executable }) {
  const workspace = createProbeWorkspace(repositoryRoot, "live", "tool-edit");
  const target = path.join(workspace.cwd, "sample.txt");
  const before = "alpha\nbeta\n";
  await writeFile(target, before, "utf8");
  const permissionCalls = [];
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const activeQuery = query({
    prompt: [
      "Read sample.txt with the Read tool.",
      "Then use the Edit tool to replace the exact text beta with gamma.",
      "Do not use Bash or Write.",
      "After the edit succeeds, reply with exactly EDIT_DONE.",
    ].join(" "),
    options: {
      ...claudeOptions({ cwd: workspace.cwd, executable }),
      sessionId: undefined,
      permissionMode: "default",
      settings: JSON.stringify({ permissions: { ask: ["Edit"] } }),
      tools: ["Read", "Edit"],
      maxTurns: 4,
      canUseTool: async (toolName, input, options) => {
        permissionCalls.push({
          toolName,
          toolUseID: options.toolUseID,
          requestId: options.requestId,
          hasSignal: options.signal instanceof AbortSignal,
          suggestions: options.suggestions ?? [],
          titlePresent: typeof options.title === "string" && options.title.length > 0,
        });
        return {
          behavior: "allow",
          updatedInput: input,
          decisionClassification: "user_temporary",
        };
      },
    },
  });
  const run = await collectQuery(activeQuery);
  const after = await readFile(target, "utf8");
  const uses = nativeToolUses(run.messages);
  const results = nativeToolResults(run.messages);
  const resultIds = new Set(results.map(({ id }) => id));
  const editResult = results
    .filter(({ id }) => uses.some((toolUse) => toolUse.id === id && toolUse.name === "Edit"))
    .map(({ value }) => value)
    .find((value) => Array.isArray(value?.structuredPatch));
  const editPermission = permissionCalls.find(({ toolName }) => toolName === "Edit");
  const checks = {
    turnSucceeded: successful(run.summary),
    readAndEditObserved:
      uses.some(({ name }) => name === "Read") && uses.some(({ name }) => name === "Edit"),
    toolResultsCorrelated: uses.every(({ id }) => resultIds.has(id)),
    editPermissionObserved: editPermission !== undefined,
    permissionToolIdMatched: uses.some(({ id }) => id === editPermission?.toolUseID),
    permissionRequestIdPresent:
      typeof editPermission?.requestId === "string" && editPermission.requestId.length > 0,
    permissionAbortSignalPresent: editPermission?.hasSignal === true,
    fileChangedAsRequested: after === "alpha\ngamma\n",
    nativeStructuredPatchPresent: Array.isArray(editResult?.structuredPatch),
    nativeStructuredPatchVerified:
      Array.isArray(editResult?.structuredPatch) &&
      verifyStructuredPatch({
        before: editResult.originalFile ?? before,
        after,
        displayPath: "sample.txt",
        structuredPatch: editResult.structuredPatch,
      }),
  };
  const result = scenarioResult({
    id: "live-tool-edit",
    profile: "live",
    required: true,
    status: scenarioStatus(checks),
    checks,
    facts: {
      toolUseCount: uses.length,
      toolResultCount: results.length,
      permissionCallbackCount: permissionCalls.length,
      permissionSuggestionCount: editPermission?.suggestions.length ?? 0,
      toolProgressCount: run.summary.typeCounts.tool_progress ?? 0,
      nativeGitPatchPresent: typeof editResult?.gitDiff?.patch === "string",
      nativeStructuredHunkCount: editResult?.structuredPatch?.length ?? 0,
    },
  });
  writeRawScenario(repositoryRoot, workspace, "tool-edit", {
    messages: run.messages,
    permissionCalls,
    before,
    after,
    result,
  });
  removeSyntheticProject(workspace);
  return result;
}

export async function runQuestionScenario({ repositoryRoot, executable }) {
  const workspace = createProbeWorkspace(repositoryRoot, "live", "question");
  const callbacks = [];
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const activeQuery = query({
    prompt: [
      "Use the AskUserQuestion tool to ask exactly one question.",
      "The question must be: Which path should we take?",
      "Use header Path and exactly two options: Alpha and Beta.",
      "After receiving the answer, reply with exactly QUESTION_DONE.",
    ].join(" "),
    options: {
      ...claudeOptions({ cwd: workspace.cwd, executable }),
      sessionId: undefined,
      permissionMode: "default",
      tools: ["AskUserQuestion"],
      maxTurns: 3,
      canUseTool: async (toolName, input, options) => {
        const questions = Array.isArray(input.questions) ? input.questions : [];
        const first = questions[0];
        const questionText = typeof first?.question === "string" ? first.question : undefined;
        const answer =
          typeof first?.options?.[0]?.label === "string" ? first.options[0].label : undefined;
        callbacks.push({
          toolName,
          toolUseID: options.toolUseID,
          requestId: options.requestId,
          hasSignal: options.signal instanceof AbortSignal,
          questions,
        });
        if (toolName !== "AskUserQuestion" || !questionText || !answer) {
          return { behavior: "deny", message: "Unexpected synthetic question" };
        }
        return {
          behavior: "allow",
          updatedInput: { ...input, answers: { [questionText]: answer } },
          decisionClassification: "user_temporary",
        };
      },
    },
  });
  const run = await collectQuery(activeQuery);
  const uses = nativeToolUses(run.messages).filter(({ name }) => name === "AskUserQuestion");
  const results = nativeToolResults(run.messages).filter(({ id }) =>
    uses.some((use) => use.id === id),
  );
  const structured = results.find(({ value }) => Array.isArray(value?.questions))?.value;
  const callback = callbacks[0];
  const answerKeysMatchQuestionText =
    Array.isArray(structured?.questions) &&
    structured.questions.every(
      (question) =>
        typeof question.question === "string" &&
        typeof structured.answers?.[question.question] === "string",
    );
  const checks = {
    turnSucceeded: successful(run.summary),
    oneQuestionCallback: callbacks.length === 1,
    askUserQuestionClassified: callback?.toolName === "AskUserQuestion",
    callbackToolIdMatched: uses.some(({ id }) => id === callback?.toolUseID),
    callbackRequestIdPresent:
      typeof callback?.requestId === "string" && callback.requestId.length > 0,
    callbackAbortSignalPresent: callback?.hasSignal === true,
    structuredQuestionResultPresent: structured !== undefined,
    answersKeyedByCompleteQuestion: answerKeysMatchQuestionText,
  };
  const result = scenarioResult({
    id: "live-question",
    profile: "live",
    required: true,
    status: scenarioStatus(checks),
    checks,
    facts: {
      questionCount: structured?.questions?.length ?? 0,
      answerCount:
        structured?.answers && typeof structured.answers === "object"
          ? Object.keys(structured.answers).length
          : 0,
    },
  });
  writeRawScenario(repositoryRoot, workspace, "question", {
    messages: run.messages,
    callbacks,
    result,
  });
  removeSyntheticProject(workspace);
  return result;
}

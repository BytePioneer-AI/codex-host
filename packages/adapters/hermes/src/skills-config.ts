import { execFile } from "node:child_process";
import { access } from "node:fs/promises";

/**
 * Hermes keeps the per-skill switch in `config.yaml` (`skills.disabled`), and the only writer that
 * preserves the file's comments and refuses essential skills is Hermes' own config code. So the
 * adapter runs a tiny python script through Hermes' interpreter instead of rewriting YAML itself.
 */
const SCRIPT = `
import json, sys
from hermes_cli.config import load_config
from hermes_cli.skills_config import get_disabled_skills, save_disabled_skills

if sys.argv[1] == "essential":
    from agent.skill_utils import ESSENTIAL_SKILLS
    print(json.dumps(sorted(ESSENTIAL_SKILLS)))
    raise SystemExit(0)

config = load_config()
disabled = set(get_disabled_skills(config))
if sys.argv[1] == "set":
    name, enable = sys.argv[2], sys.argv[3] == "1"
    if enable:
        disabled.discard(name)
    else:
        disabled.add(name)
    save_disabled_skills(config, disabled)
    # Re-read so essential skills Hermes silently refuses show their real state.
    disabled = set(get_disabled_skills(load_config()))
print(json.dumps(sorted(disabled)))
`;

const TIMEOUT_MS = 15_000;

/** Hermes' own interpreter: the venv that carries its config writers. */
export async function hermesAgentPython(
  environment: NodeJS.ProcessEnv,
): Promise<{ python: string; agentDirectory: string } | undefined> {
  const home = environment["HOME"];
  if (typeof home !== "string" || home.length === 0) return undefined;
  const agentDirectory = `${home}/.hermes/hermes-agent`;
  const python = `${agentDirectory}/venv/bin/python3`;
  try {
    await access(python);
  } catch {
    return undefined;
  }
  return { python, agentDirectory };
}

function run(
  python: string,
  agentDirectory: string,
  environment: NodeJS.ProcessEnv,
  argv: readonly string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      python,
      ["-c", SCRIPT, ...argv],
      {
        timeout: TIMEOUT_MS,
        env: { ...environment, PYTHONPATH: agentDirectory },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        const line = stdout.trim().split("\n").at(-1) ?? "";
        resolve(line);
      },
    );
  });
}

function parseDisabled(text: string): Set<string> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return undefined;
    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return undefined;
  }
}

/** Names Hermes will not load, or undefined when its config cannot be read (the page goes read-only). */
export async function readDisabledSkills(
  environment: NodeJS.ProcessEnv,
): Promise<Set<string> | undefined> {
  const interpreter = await hermesAgentPython(environment);
  if (!interpreter) return undefined;
  try {
    return parseDisabled(
      await run(interpreter.python, interpreter.agentDirectory, environment, ["get"]),
    );
  } catch {
    return undefined;
  }
}

/**
 * Flips one skill in Hermes' config and returns the state Hermes actually persisted — a refusal
 * (essential skill, unreadable config) shows up as the name still being disabled.
 */
export async function setSkillDisabled(
  environment: NodeJS.ProcessEnv,
  name: string,
  enabled: boolean,
): Promise<Set<string> | undefined> {
  const interpreter = await hermesAgentPython(environment);
  if (!interpreter) return undefined;
  try {
    return parseDisabled(
      await run(interpreter.python, interpreter.agentDirectory, environment, [
        "set",
        name,
        enabled ? "1" : "0",
      ]),
    );
  } catch {
    return undefined;
  }
}

/**
 * Skill names Hermes marks as essential (`hermes-agent`): it refuses to disable them, and they must
 * never be deleted either. An unreadable list yields an empty set, so removal still defers to the
 * other guard rails rather than silently allowing everything.
 */
export async function readEssentialSkills(environment: NodeJS.ProcessEnv): Promise<Set<string>> {
  const interpreter = await hermesAgentPython(environment);
  if (!interpreter) return new Set();
  try {
    return (
      parseDisabled(
        await run(interpreter.python, interpreter.agentDirectory, environment, ["essential"]),
      ) ?? new Set()
    );
  } catch {
    return new Set();
  }
}

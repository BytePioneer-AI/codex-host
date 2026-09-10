import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { harnessIdSchema } from "@codexhost/shared-contracts";

const delayedWrite = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/delayed-write.py",
);

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function createHermeticGrokAdapter() {
  const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("grok"));
  const jobs = new WeakMap();
  const originalOpen = adapter.open.bind(adapter);
  adapter.open = async (input) => {
    const opened = await originalOpen(input);
    if (!opened.ok) return opened;
    const session = opened.value;
    const originalExecute = session.execute.bind(session);
    session.execute = async (command) => {
      const accepted = await originalExecute(command);
      if (accepted.ok && command.type === "turn.start") {
        const text = command.input.map((part) => part.text).join("\n");
        const hold = text.match(/OBSERVE_HOLD:(\S+)/u)?.[1];
        const startedFile = text.match(/PROBE_STARTED:(\S+)/u)?.[1];
        const lateFile = text.match(/PROBE_LATE:(\S+)/u)?.[1];
        const finish = () => {
          if (session.closed) return;
          if (text.includes("EVIDENCE_PRIVACY")) {
            session.startReasoning("secret-thought-xyz");
          }
          if (text.includes("EVIDENCE_TOOL") || text.includes("EVIDENCE_PRIVACY")) {
            for (const command of ["cat sentinel.txt", "cat other.txt", "cat third.txt"]) {
              const itemId = session.startCommandExecution(command, input.cwd);
              session.completeItem(itemId, { status: "succeeded" });
            }
          }
          session.appendText(
            text.includes("OBSERVE04_BODY_") ? text : `HERMETIC:${text.slice(0, 200)}`,
          );
          session.succeedTurn();
        };
        if (startedFile && lateFile) {
          const child = spawn(process.env.PYTHON ?? "python3", [delayedWrite], {
            detached: true,
            stdio: "ignore",
            env: {
              ...process.env,
              PROBE_STARTED: startedFile,
              PROBE_LATE: lateFile,
              PROBE_DELAY: text.includes("PROBE_DELAY:")
                ? (text.match(/PROBE_DELAY:(\d+)/u)?.[1] ?? "8")
                : "8",
            },
          });
          if (child.pid) {
            child.unref();
            const owned = jobs.get(session) ?? [];
            owned.push({ pid: child.pid, pgid: child.pid });
            jobs.set(session, owned);
          }
        }
        if (hold) {
          const startedAt = Date.now();
          const timer = setInterval(async () => {
            try {
              await stat(hold);
              clearInterval(timer);
              finish();
            } catch {
              if (Date.now() - startedAt > 8_000) {
                clearInterval(timer);
                finish();
              }
            }
          }, 20);
        } else {
          queueMicrotask(finish);
        }
      }
      return accepted;
    };
    return opened;
  };
  adapter.stopOwnedJobs = async (session) => {
    const owned = jobs.get(session) ?? [];
    if (owned.length === 0) return { quiescence: "confirmed" };
    for (const job of owned) {
      try {
        process.kill(-job.pgid, "SIGKILL");
      } catch {
        try {
          process.kill(job.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && owned.some((job) => processIsAlive(job.pid))) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const alive = owned.find((job) => processIsAlive(job.pid));
    if (alive) {
      return {
        quiescence: "unknown",
        proof: { pid: alive.pid, pgid: alive.pgid, scope: "hermetic-probe" },
      };
    }
    return {
      quiescence: "confirmed",
      proof: { pid: owned[0]?.pid, pgid: owned[0]?.pgid, scope: "hermetic-probe" },
    };
  };
  return adapter;
}

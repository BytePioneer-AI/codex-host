import type { JsonValue } from "@codexhost/shared-contracts";

interface ClaudeTask {
  id: string;
  subject: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" && field.length > 0) return field;
  }
  return undefined;
}

function taskStatus(value: unknown): ClaudeTask["status"] | "deleted" | undefined {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "deleted"
    ? value
    : undefined;
}

export function isClaudeTaskTool(toolName: string): boolean {
  return toolName === "TaskCreate" || toolName === "TaskUpdate" || toolName === "TaskList";
}

export class ClaudeTaskTracker {
  readonly #tasks = new Map<string, ClaudeTask>();

  apply(toolName: string, args: JsonValue, result: JsonValue | undefined): JsonValue | null {
    if (toolName === "TaskCreate") this.#create(args, result);
    else if (toolName === "TaskUpdate") this.#update(args);
    else if (toolName === "TaskList") this.#replace(result);
    else return null;

    return {
      todos: [...this.#tasks.values()].map(({ id, subject, status }) => ({
        id,
        content: subject,
        status,
      })),
    };
  }

  #create(args: JsonValue, result: JsonValue | undefined): void {
    if (!isRecord(result) || !isRecord(result.task)) return;
    const id = stringField(result.task, ["id"]);
    const subject = stringField(args, ["subject"]) ?? stringField(result.task, ["subject"]);
    if (!id || !subject) return;
    const activeForm = stringField(args, ["activeForm", "active_form"]);
    this.#tasks.set(id, {
      id,
      subject,
      ...(activeForm ? { activeForm } : {}),
      status: "pending",
    });
  }

  #update(args: JsonValue): void {
    const id = stringField(args, ["taskId", "id", "task_id"]);
    if (!id) return;
    const status = isRecord(args) ? taskStatus(args.status) : undefined;
    if (status === "deleted") {
      this.#tasks.delete(id);
      return;
    }
    const existing = this.#tasks.get(id);
    const subject = stringField(args, ["subject"]) ?? existing?.subject;
    if (!subject) return;
    const activeForm = stringField(args, ["activeForm", "active_form"]) ?? existing?.activeForm;
    this.#tasks.set(id, {
      id,
      subject,
      ...(activeForm ? { activeForm } : {}),
      status: status ?? existing?.status ?? "pending",
    });
  }

  #replace(result: JsonValue | undefined): void {
    if (!isRecord(result) || !Array.isArray(result.tasks)) return;
    const next = new Map<string, ClaudeTask>();
    for (const value of result.tasks) {
      const id = stringField(value, ["id"]);
      const subject = stringField(value, ["subject"]);
      const status = isRecord(value) ? taskStatus(value.status) : undefined;
      if (!id || !subject || !status || status === "deleted") continue;
      const existing = this.#tasks.get(id);
      next.set(id, {
        id,
        subject,
        ...(existing?.activeForm ? { activeForm: existing.activeForm } : {}),
        status,
      });
    }
    this.#tasks.clear();
    for (const [id, task] of next) this.#tasks.set(id, task);
  }
}

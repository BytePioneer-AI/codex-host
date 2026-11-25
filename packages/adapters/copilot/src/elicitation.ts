import type { SessionConfig } from "@github/copilot-sdk";
import type { HostQuestion, HostQuestionResponse } from "@codexhost/harness-adapter";
import { CopilotOperationError } from "./errors.js";

type Handler = NonNullable<SessionConfig["onElicitationRequest"]>;
export type ElicitationContext = Parameters<Handler>[0];
export type ElicitationResult = Awaited<ReturnType<Handler>>;
type Field = NonNullable<ElicitationContext["requestedSchema"]>["properties"][string];

function calendarDate(value: string): boolean {
  const timestamp = Date.parse(value);
  return (
    /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
  );
}

function options(field: Field): Array<{ value: string; label: string }> | undefined {
  if (field.type === "boolean")
    return [
      { value: "true", label: "Yes" },
      { value: "false", label: "No" },
    ];
  if (field.type === "string" && "enum" in field)
    return field.enum.map((value, index) => ({ value, label: field.enumNames?.[index] ?? value }));
  if (field.type === "string" && "oneOf" in field)
    return field.oneOf.map((option) => ({ value: option.const, label: option.title }));
  if (field.type === "array") {
    return "enum" in field.items
      ? field.items.enum.map((value) => ({ value, label: value }))
      : field.items.anyOf.map((option) => ({ value: option.const, label: option.title }));
  }
}

export function elicitationForm(context: ElicitationContext) {
  const schema = context.requestedSchema;
  if (
    context.mode === "url" ||
    !schema ||
    schema.type !== "object" ||
    !Object.keys(schema.properties).length
  )
    throw new CopilotOperationError(
      "unsupported",
      "Copilot elicitation requires a supported primitive form; browser URL flows are unavailable.",
    );
  if (schema.required?.some((id) => !Object.hasOwn(schema.properties, id)))
    throw new Error("Copilot form refers to an unknown required field");
  const questions: HostQuestion[] = Object.entries(schema.properties).map(([id, field]) => {
    const allowed = new Set([
      "type",
      "title",
      "description",
      "default",
      ...(field.type === "string"
        ? ["enum", "enumNames", "oneOf", "minLength", "maxLength", "format"]
        : field.type === "array"
          ? ["items", "minItems", "maxItems"]
          : field.type === "number" || field.type === "integer"
            ? ["minimum", "maximum"]
            : []),
    ]);
    if (Object.keys(field).some((key) => !allowed.has(key)))
      throw new CopilotOperationError(
        "unsupported",
        "Copilot form contains an unsupported constraint.",
      );
    if (
      "format" in field &&
      field.format &&
      !["email", "uri", "date", "date-time"].includes(field.format)
    )
      throw new CopilotOperationError(
        "unsupported",
        "Copilot form contains an unsupported text format.",
      );
    if (!["string", "number", "integer", "boolean", "array"].includes(field.type))
      throw new CopilotOperationError("unsupported", "Copilot form field cannot be represented");
    const prompt = [field.title ?? id, field.description].filter(Boolean).join("\n");
    const choices = options(field);
    const optional = !schema.required?.includes(id);
    if (choices)
      return {
        id,
        type: "choice",
        prompt,
        options: choices,
        multiple: field.type === "array",
        allowOther: false,
        optional,
      };
    return {
      id,
      type: "text",
      prompt,
      multiline: field.type === "string",
      secret: false,
      optional,
      ...(field.default === undefined ? {} : { prefill: String(field.default) }),
    };
  });
  const decode = (response: HostQuestionResponse): ElicitationResult => {
    if (response.cancelled) return { action: "cancel" };
    const content: NonNullable<ElicitationResult["content"]> = Object.create(null);
    for (const [id, field] of Object.entries(schema.properties)) {
      const values = Object.hasOwn(response.answers, id) ? (response.answers[id] ?? []) : [];
      if (!values.length) continue;
      const value = values[0] ?? "";
      if (field.type === "array") {
        if (
          (field.minItems !== undefined && values.length < field.minItems) ||
          (field.maxItems !== undefined && values.length > field.maxItems)
        )
          throw new Error("The number of choices is outside the native form's limits.");
        content[id] = values;
        continue;
      }
      if (field.type === "boolean") {
        content[id] = value === "true";
        continue;
      }
      if (field.type === "number" || field.type === "integer") {
        const number = Number(value);
        if (
          !value.trim() ||
          !Number.isFinite(number) ||
          (field.type === "integer" && !Number.isSafeInteger(number)) ||
          (field.minimum !== undefined && number < field.minimum) ||
          (field.maximum !== undefined && number > field.maximum)
        )
          throw new Error("The number is outside the native form's limits.");
        content[id] = number;
        continue;
      }
      if (field.type === "string") {
        if (
          ("minLength" in field &&
            field.minLength !== undefined &&
            Array.from(value).length < field.minLength) ||
          ("maxLength" in field &&
            field.maxLength !== undefined &&
            Array.from(value).length > field.maxLength)
        )
          throw new Error("The text length is outside the native form's limits.");
        if ("format" in field && field.format) {
          const valid =
            field.format === "email"
              ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)
              : field.format === "uri"
                ? URL.canParse(value)
                : field.format === "date"
                  ? calendarDate(value)
                  : calendarDate(value.slice(0, 10)) &&
                    /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/iu.test(
                      value,
                    ) &&
                    !Number.isNaN(Date.parse(value));
          if (!valid) throw new Error("The text does not match the native form's format.");
        }
        content[id] = value;
      }
    }
    return { action: "accept", content };
  };
  return { questions, decode };
}

import { Type, type Static } from "typebox";

const questionParameters = Type.Object(
  {
    prompt: Type.String({ description: "The question to ask the user" }),
    options: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: "Optional choices. Omit for a free-text answer.",
        minItems: 2,
      }),
    ),
    multiline: Type.Optional(
      Type.Boolean({ description: "Use a multiline editor for a free-text answer" }),
    ),
  },
  { additionalProperties: false },
);

type QuestionParameters = Static<typeof questionParameters>;

interface QuestionExtensionContext {
  hasUI: boolean;
  ui: {
    select(
      title: string,
      options: string[],
      dialogOptions?: { signal?: AbortSignal },
    ): Promise<string | undefined>;
    input(
      title: string,
      placeholder?: string,
      dialogOptions?: { signal?: AbortSignal },
    ): Promise<string | undefined>;
    editor(title: string, prefill?: string): Promise<string | undefined>;
  };
}

interface QuestionExtensionApi {
  registerTool(definition: {
    name: string;
    label: string;
    description: string;
    promptSnippet: string;
    promptGuidelines: string[];
    parameters: typeof questionParameters;
    execute(
      toolCallId: string,
      params: QuestionParameters,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      context: QuestionExtensionContext,
    ): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: { answered: boolean; answerType: "choice" | "text" };
    }>;
  }): void;
}

export default function codexhostQuestionExtension(pi: QuestionExtensionApi): void {
  pi.registerTool({
    name: "codexhost_question",
    label: "Ask user",
    description:
      "Ask the user one blocking choice or free-text question and wait for their answer.",
    promptSnippet: "Ask the user one blocking choice or free-text question",
    promptGuidelines: [
      "Use codexhost_question only when progress requires information or a decision from the user.",
    ],
    parameters: questionParameters,
    async execute(_toolCallId, params, signal, _onUpdate, context) {
      if (!context.hasUI) throw new Error("codexhost_question requires an interactive client");
      if (params.options && params.multiline) {
        throw new Error("codexhost_question multiline mode cannot have choices");
      }
      const answerType = params.options ? "choice" : "text";
      const dialogOptions = signal ? { signal } : {};
      const answer = params.options
        ? await context.ui.select(params.prompt, params.options, dialogOptions)
        : params.multiline
          ? await context.ui.editor(params.prompt)
          : await context.ui.input(params.prompt, undefined, dialogOptions);
      return {
        content: [
          {
            type: "text",
            text:
              answer === undefined ? "The user cancelled the question." : `User answer: ${answer}`,
          },
        ],
        details: { answered: answer !== undefined, answerType },
      };
    },
  });
}

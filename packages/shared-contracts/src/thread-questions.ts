import { z } from "zod";

export const THREAD_QUESTIONS_LIST_METHOD = "codexhost/thread/questions/list";
export const THREAD_QUESTION_RESPOND_METHOD = "codexhost/thread/question/respond";

const field = z.discriminatedUnion("type", [
  z.object({
    id: z.string().min(1),
    type: z.literal("choice"),
    prompt: z.string(),
    options: z
      .array(
        z.object({
          value: z.string().min(1),
          label: z.string(),
          description: z.string().optional(),
        }),
      )
      .min(1),
    multiple: z.boolean(),
    allowOther: z.boolean(),
    optional: z.boolean(),
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal("text"),
    prompt: z.string(),
    multiline: z.boolean(),
    secret: z.literal(false),
    optional: z.boolean(),
    placeholder: z.string().optional(),
    prefill: z.string().optional(),
  }),
]);

/** A whole interaction stays on one surface, including mixed choice/text groups. */
export const threadQuestionSchema = z
  .object({
    interactionId: z.string().min(1),
    turnId: z.string().min(1),
    title: z.string().optional(),
    questions: z.array(field).min(1),
  })
  .refine(({ questions }) => questions.some((q) => q.type === "choice" && q.multiple), {
    message: "Shared cards require at least one multi-select question",
  });
export type ThreadQuestion = z.infer<typeof threadQuestionSchema>;
export const threadQuestionsListParamsSchema = z.strictObject({ threadId: z.string().min(1) });
export const threadQuestionsResultSchema = z.object({ questions: z.array(threadQuestionSchema) });
export const threadQuestionRespondParamsSchema = z.strictObject({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  interactionId: z.string().min(1),
  answers: z.record(z.string(), z.array(z.string())),
  cancelled: z.boolean().default(false),
});
export const threadQuestionRespondResultSchema = z.object({ accepted: z.literal(true) });

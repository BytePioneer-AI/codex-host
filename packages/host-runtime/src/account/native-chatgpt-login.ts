import { z } from "zod";

/** Native 0.153.4 ChatGPT login contracts, not Host Settings login semantics. */
export const nativeChatgptLoginParamsSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("chatgpt"),
      codexStreamlinedLogin: z.boolean().optional(),
      useHostedLoginSuccessPage: z.boolean().optional(),
      appBrand: z.enum(["codex", "chatgpt"]).nullable().optional(),
    })
    .strict(),
  z.object({ type: z.literal("chatgptDeviceCode") }).strict(),
]);
export type NativeChatgptLoginParams = z.infer<typeof nativeChatgptLoginParamsSchema>;

const nonBlank = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => value.trim().length > 0);
const loginUrl = z
  .string()
  .url()
  .max(16_384)
  .refine((value) => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      ["https://auth.openai.com", "https://chatgpt.com"].includes(url.origin)
    );
  });
export const nativeChatgptLoginResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("chatgpt"), loginId: nonBlank, authUrl: loginUrl }),
  z.object({
    type: z.literal("chatgptDeviceCode"),
    loginId: nonBlank,
    verificationUrl: loginUrl,
    userCode: nonBlank,
  }),
]);
export type NativeChatgptLoginResponse = z.infer<typeof nativeChatgptLoginResponseSchema>;

export interface NativeChatgptLoginCompleted {
  loginId: string;
  success: boolean;
  error: string | null;
  onboardingEntrypoint: "life_sciences" | null;
}

/** A completion Promise preserves response-before-event ordering even when the
 * native operation settles before start returns. It never rejects or contains credentials. */
export interface NativeChatgptLogin {
  response: NativeChatgptLoginResponse;
  completed: Promise<NativeChatgptLoginCompleted>;
}

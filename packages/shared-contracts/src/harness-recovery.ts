import { z } from "zod";
import { hostTurnIdSchema } from "./ids.js";
import { nativeTurnRefSchema } from "./native-refs.js";

/** Host-owned identity paired with a previously confirmed native logical Turn. */
export const harnessKnownTurnSchema = z
  .object({
    turnId: hostTurnIdSchema,
    nativeTurnRef: nativeTurnRefSchema,
  })
  .strict();
export type HarnessKnownTurn = z.infer<typeof harnessKnownTurnSchema>;

/** Initial live work to reattach, never a request to send the input again. */
export const harnessTurnRecoverySchema = harnessKnownTurnSchema
  .extend({
    input: z.array(z.object({ type: z.literal("text"), text: z.string().max(4_000_000) }).strict()),
  })
  .strict();
export type HarnessTurnRecovery = z.infer<typeof harnessTurnRecoverySchema>;

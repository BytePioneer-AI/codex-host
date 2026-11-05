import type { ChatViewSlotProps } from "../contract/slots.ts";

declare module "@deepseek-ai/dsh-session-projection/types" {
  interface SessionProjectionMap {
    /** Native Turn boundaries in milliseconds; null means the Host has no actual time. */
    codexhostTurnTimes: Readonly<Record<string, { start: number | null; end: number | null }>>;
  }
}

/** Message labels must not display the synthetic timestamps used to replay untimed history. */
export function useTurnMessageTime(
  useProjection: ChatViewSlotProps["useProjection"],
  turn: number | undefined,
  boundary: "start" | "end",
): number | undefined {
  return useProjection("codexhostTurnTimes", (times) =>
    turn === undefined ? undefined : (times?.[turn]?.[boundary] ?? undefined),
  );
}

/** Conversation activity for Web list ordering and labels; metadata writes keep their own clock. */
export function threadRecencyMs(thread: {
  updatedAt: number;
  recencyAt?: number | null | undefined;
}): number {
  return (thread.recencyAt ?? thread.updatedAt) * 1000;
}

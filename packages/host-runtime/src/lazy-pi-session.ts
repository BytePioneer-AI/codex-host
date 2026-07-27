export interface PiTextSession {
  start(): Promise<unknown>;
  close(): Promise<void>;
  runTextTurn(text: string, onDelta?: (delta: string) => void): Promise<{ text: string }>;
}

export class LazyPiSession {
  readonly #factory: () => PiTextSession;
  #session: PiTextSession | null = null;
  #starting: Promise<PiTextSession> | null = null;

  constructor(factory: () => PiTextSession) {
    this.#factory = factory;
  }

  get started(): boolean {
    return this.#session !== null;
  }

  async runTextTurn(text: string, onDelta?: (delta: string) => void): Promise<{ text: string }> {
    const session = await this.#ensureStarted();
    return session.runTextTurn(text, onDelta);
  }

  async close(): Promise<void> {
    const starting = this.#starting;
    const session = this.#session ?? (starting ? await starting.catch(() => null) : null);
    this.#session = null;
    this.#starting = null;
    if (session) await session.close();
  }

  async #ensureStarted(): Promise<PiTextSession> {
    if (this.#session) return this.#session;
    if (this.#starting) return this.#starting;
    const session = this.#factory();
    const starting = session
      .start()
      .then(() => {
        this.#session = session;
        return session;
      })
      .catch(async (error: unknown) => {
        await session.close().catch(() => undefined);
        throw error;
      })
      .finally(() => {
        if (this.#starting === starting) this.#starting = null;
      });
    this.#starting = starting;
    return starting;
  }
}

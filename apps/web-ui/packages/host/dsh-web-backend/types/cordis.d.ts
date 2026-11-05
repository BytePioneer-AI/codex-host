/** Type surface of the Cordis framework the backend composes. */
export interface Fiber {
  state: number;
  inertia?: Promise<void>;
  inject: Record<string, unknown>;
  ctx: Context;
  await(): Promise<void>;
  dispose(): Promise<void>;
}
export class Service {
  static readonly init: unique symbol;
}

export interface TypertLookups {
  register(key: string, provider: unknown): unknown;
}

export interface TypertRegistryService {
  register(contribution: unknown): unknown;
  lookups: TypertLookups;
}

export class Context {
  constructor(options?: unknown);
  plugin(plugin: unknown, config?: unknown): PromiseLike<unknown> & Fiber;
  provide(name: string, value: unknown): void;
  isolate(name: string): Context;
  get(name: string): unknown;
  baseUrl?: string;
  effect(callback: () => (() => void) | (() => Promise<void>), label?: string): unknown;
  readonly fiber: Fiber;
  readonly typert: TypertRegistryService;
}

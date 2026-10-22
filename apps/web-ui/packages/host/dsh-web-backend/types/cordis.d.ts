/** Type surface of the Cordis framework the backend composes. */
export interface Fiber {
  dispose(): Promise<void>;
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
  get(name: string): unknown;
  readonly fiber: Fiber;
  readonly typert: TypertRegistryService;
}

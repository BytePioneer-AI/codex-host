interface StatsKv {
  get(key: string): Promise<string | null>;
  get(keys: string[]): Promise<Map<string, string | null>>;
  put(key: string, value: string): Promise<void>;
  list(options: { prefix: string; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

declare const worker: {
  fetch(request: Request, environment: { STATS_KV: StatsKv }): Promise<Response>;
};

export default worker;

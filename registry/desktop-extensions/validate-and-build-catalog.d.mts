export function buildCatalog(options?: {
  directory?: URL | string;
  checkOnly?: boolean;
}): Promise<{ failed: boolean; markdown: string }>;

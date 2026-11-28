export function parseContentLength(value: string | null | undefined): number | undefined {
  if (value == null || !/^\d+$/u.test(value)) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : undefined;
}

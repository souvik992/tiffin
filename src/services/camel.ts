/** snake_case DB rows to camelCase API objects. */
export function camel<T = Record<string, unknown>>(row: unknown): T {
  if (row === null || row === undefined) return row as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    out[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return out as T;
}
export const camelAll = <T = Record<string, unknown>>(rows: unknown[]): T[] => rows.map((r) => camel<T>(r));

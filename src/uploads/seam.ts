// Shared DB-executor seam for the unit-file write/GC/delete cores. The app injects a pg Pool (which
// returns `{ rows }`); an integration test injects @neondatabase/serverless (which returns a bare
// array). rowsOf() normalizes both so every injected-seam query doesn't re-derive the idiom.
export type Queryable = { query: (text: string, params: unknown[]) => Promise<unknown> };

export function rowsOf<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : (raw as { rows: T[] }).rows) as T[];
}

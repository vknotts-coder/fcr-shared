// Shared DB-executor seam for the unit-file write/GC/delete cores. The app injects a pg Pool (which
// returns `{ rows }`); an integration test injects @neondatabase/serverless (which returns a bare
// array). rowsOf() normalizes both so every injected-seam query doesn't re-derive the idiom.
export type Queryable = { query: (text: string, params: unknown[]) => Promise<unknown> };

export function rowsOf<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : (raw as { rows: T[] }).rows) as T[];
}

// The one allowed-character policy for a user-supplied unit-file name, shared by the write core
// (storing the clean filename) and the proxy (the Content-Disposition filename) so the policy can't
// drift between them — the whole reason this subsystem is one module (the proxy header records how
// `nosniff` drifted between two app routes before). Callers add their own length cap / fallback.
export function sanitizeFilename(name: string): string {
  // Allow SPACES in a display filename (in addition to word chars, dot and dash) so a shop naming convention
  // survives verbatim (fcr-estimating #38, e.g. "Invoice - RO-1234.pdf" instead of "Invoice_-_RO-1234.pdf").
  // Spaces are safe for both consumers: the stored unit_file.filename (a text column) and the
  // Content-Disposition `filename="…"` (a quoted-string, where a space is legal). All whitespace is first
  // collapsed to a single space (so tabs/newlines/runs never widen the name), then every remaining
  // non-allowed character — quotes, slashes, control chars — still collapses to "_", and the result is trimmed.
  return name.replace(/\s+/g, " ").replace(/[^\w.\- ]/g, "_").trim();
}

// @fcr/core/search — the global-search KERNEL, lifted from the near-identical copies in
// fcr-dispatch/fcr-trailers src/lib/search.ts (fcr-dispatch#59). This is the ONE shared
// definition of the Salesforce-style "search everything" surface's mechanics: the hit shape,
// the min-term-length floor, LIKE-metacharacter escaping, per-group failure isolation, and the
// parallel orchestration + render-order/count helpers.
//
// What it deliberately does NOT own: the queries. Which tables/columns each app searches, the
// hrefs a hit links to, and the audience gate all stay in the app — they're schema- and
// route-specific and legitimately differ (dispatch searches trucks/trailers/customers/drivers
// with pg_trgm-indexed columns; trailers searches trailers/parts/accounts/contacts). So the app
// passes its groups in and the kernel runs them, the SAME injection seam @fcr/core/rbac (pool)
// and /events (Queryable) use so this package never imports an app's db module.
//
// The extraction fixes a live drift between the two copies: the trailer copy did NOT escape LIKE
// metacharacters (a user typing "%" matched every row) and used a 2-char floor. Routing both
// apps through this kernel makes escaping and the floor a single source of truth.

/** A single search result, rendered identically by the type-ahead dropdown and the /search page. */
export interface SearchHit {
  id: string;
  /** Primary line (unit #, customer/account name, driver/contact name, part #). */
  label: string;
  /** Secondary context line (status + customer, city/state/phone, parent unit, …). */
  sublabel: string | null;
  /** Where clicking the hit goes. Absent ⇒ rendered non-clickable (no useful/enabled target). */
  href?: string;
}

/** Grouped hits keyed by the app's own group union (e.g. "trucks" | "trailers" | …). */
export type SearchResults<K extends string> = Record<K, SearchHit[]>;

/**
 * Minimum query length before any group runs. Defaults to 3 to match pg_trgm's trigram minimum:
 * a `gin_trgm_ops` index can only serve `ILIKE '%term%'` when the literal has a full 3-char
 * trigram, so a shorter term would silently seq-scan a per-keystroke search. It is NECESSARY, not
 * sufficient — a 3-char term split by a space/punctuation ("J D") has no trigram and still
 * seq-scans; the floor only rules out the always-unindexable 1–2 char case. An app with no trgm
 * index (small tables) can override via `minLength`.
 */
export const SEARCH_MIN_TERM_LENGTH = 3;

/**
 * Escape the ILIKE metacharacters (`%`, `_`, and the `\` escape char itself) so a user typing
 * "%" or "_" searches for the literal character instead of a wildcard (a bare "%" would otherwise
 * match every row). Postgres ILIKE's default escape is backslash, so no ESCAPE clause is needed.
 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** What each group's `run` receives: the trimmed term, the ready-to-bind ILIKE pattern (already
 *  escaped and `%`-wrapped — bind it as your `$1`, do NOT re-wrap), and the per-group row cap. */
export interface SearchContext {
  term: string;
  like: string;
  limit: number;
}

/**
 * One searchable group. `run` fetches raw rows for the term (typically
 * `pool().query(sql, [ctx.like, ctx.limit]).then(r => r.rows)`), `map` turns them into SearchHits.
 * `run`/`map` close over the app's pool and routes, so the kernel stays DB- and route-free.
 */
export interface SearchGroupDef<K extends string, Row = unknown> {
  key: K;
  /** Section heading shown by the UI ("Trucks", "Back Order Parts", …). */
  title: string;
  run: (ctx: SearchContext) => Promise<Row[]>;
  map: (rows: Row[]) => SearchHit[];
}

/** Build an all-empty result set in the groups' order (blank/too-short query, or before a run). */
export function emptyResults<K extends string>(groups: readonly SearchGroupDef<K>[]): SearchResults<K> {
  const out = {} as SearchResults<K>;
  for (const g of groups) out[g.key] = [];
  return out;
}

// Run one group and map its rows; on ANY failure return [] + log, so a single bad column/table
// degrades that group instead of failing the whole search (Promise.all would otherwise reject).
async function runGroup<K extends string, Row>(
  def: SearchGroupDef<K, Row>,
  ctx: SearchContext,
): Promise<SearchHit[]> {
  try {
    return def.map(await def.run(ctx));
  } catch (err) {
    console.error(`runSearch: "${def.key}" group failed — returning no hits for it`, err);
    return [];
  }
}

export interface RunSearchOptions {
  /** Per-group cap (small for the dropdown, larger for the /search page). Default 6. */
  limit?: number;
  /** Override the term floor (default SEARCH_MIN_TERM_LENGTH). */
  minLength?: number;
}

/**
 * Search everything for `q` across `groups`. Returns empty groups (in order) for a blank/too-short
 * query. Escapes the term once, runs every group in parallel, and isolates failures per group.
 */
export async function runSearch<K extends string>(
  q: string,
  groups: readonly SearchGroupDef<K>[],
  opts: RunSearchOptions = {},
): Promise<SearchResults<K>> {
  const minLength = opts.minLength ?? SEARCH_MIN_TERM_LENGTH;
  const limit = opts.limit ?? 6;
  const term = q.trim();
  if (term.length < minLength) return emptyResults(groups);

  const ctx: SearchContext = { term, like: `%${escapeLike(term)}%`, limit };
  const hits = await Promise.all(groups.map((g) => runGroup(g, ctx)));

  const out = {} as SearchResults<K>;
  groups.forEach((g, i) => {
    out[g.key] = hits[i]!;
  });
  return out;
}

/** The non-empty groups of a result set, in the given render order (one source of truth for the
 *  dropdown and the /search page — pass the order derived from the app's groups array). */
export function nonEmptyGroups<K extends string>(r: SearchResults<K>, order: readonly K[]): K[] {
  return order.filter((k) => r[k].length > 0);
}

/** Total hit count across all groups (for "N results" affordances). */
export function totalHits<K extends string>(r: SearchResults<K>): number {
  let n = 0;
  for (const k in r) n += r[k].length;
  return n;
}

/**
 * Bind a fixed groups array once into the handful of values an app needs, so its render `order`,
 * `titles`, `empty` set, and the `search`/`nonEmptyGroups`/`totalHits` helpers can't drift out of
 * sync with each other. This is the ergonomic entry point for an app's lib/search.ts:
 *
 *   const GROUPS = [ { key: "trucks", title: "Trucks", run, map }, … ] as const;
 *   export const { search, order, titles, nonEmptyGroups, totalHits } = defineSearch(GROUPS);
 *
 * `defaults` sets this app's limit/minLength floor once; a per-call `search(q, { limit })` (the
 * dropdown's smaller cap) still overrides them.
 */
export function defineSearch<K extends string>(
  groups: readonly SearchGroupDef<K>[],
  defaults: RunSearchOptions = {},
) {
  const order = groups.map((g) => g.key);
  const titles = {} as Record<K, string>;
  for (const g of groups) titles[g.key] = g.title;

  return {
    /** Render order of the groups (their array order). */
    order,
    /** Group key → section heading. */
    titles,
    /** An all-empty result set in order. */
    empty: (): SearchResults<K> => emptyResults(groups),
    /** Run the search; per-call opts override this app's defaults. */
    search: (q: string, opts: RunSearchOptions = {}): Promise<SearchResults<K>> =>
      runSearch(q, groups, { ...defaults, ...opts }),
    /** Non-empty groups in render order. */
    nonEmptyGroups: (r: SearchResults<K>): K[] => nonEmptyGroups(r, order),
    /** Total hits across groups. */
    totalHits,
  };
}

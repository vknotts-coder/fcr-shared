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
export declare const SEARCH_MIN_TERM_LENGTH = 3;
/**
 * Escape the ILIKE metacharacters (`%`, `_`, and the `\` escape char itself) so a user typing
 * "%" or "_" searches for the literal character instead of a wildcard (a bare "%" would otherwise
 * match every row). Postgres ILIKE's default escape is backslash, so no ESCAPE clause is needed.
 */
export declare function escapeLike(s: string): string;
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
export declare function emptyResults<K extends string>(groups: readonly SearchGroupDef<K>[]): SearchResults<K>;
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
export declare function runSearch<K extends string>(q: string, groups: readonly SearchGroupDef<K>[], opts?: RunSearchOptions): Promise<SearchResults<K>>;
/** The non-empty groups of a result set, in the given render order (one source of truth for the
 *  dropdown and the /search page — pass the order derived from the app's groups array). */
export declare function nonEmptyGroups<K extends string>(r: SearchResults<K>, order: readonly K[]): K[];
/** Total hit count across all groups (for "N results" affordances). */
export declare function totalHits<K extends string>(r: SearchResults<K>): number;
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
export declare function defineSearch<K extends string>(groups: readonly SearchGroupDef<K>[], defaults?: RunSearchOptions): {
    /** Render order of the groups (their array order). */
    order: K[];
    /** Group key → section heading. */
    titles: Record<K, string>;
    /** An all-empty result set in order. */
    empty: () => SearchResults<K>;
    /** Run the search; per-call opts override this app's defaults. */
    search: (q: string, opts?: RunSearchOptions) => Promise<SearchResults<K>>;
    /** Non-empty groups in render order. */
    nonEmptyGroups: (r: SearchResults<K>) => K[];
    /** Total hits across groups. */
    totalHits: typeof totalHits;
};
//# sourceMappingURL=index.d.ts.map
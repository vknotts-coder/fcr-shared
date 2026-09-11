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
export function escapeLike(s) {
    return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
/** Build an all-empty result set in the groups' order (blank/too-short query, or before a run). */
export function emptyResults(groups) {
    const out = {};
    for (const g of groups)
        out[g.key] = [];
    return out;
}
// Run one group and map its rows; on ANY failure return [] + log, so a single bad column/table
// degrades that group instead of failing the whole search (Promise.all would otherwise reject).
async function runGroup(def, ctx) {
    try {
        return def.map(await def.run(ctx));
    }
    catch (err) {
        console.error(`runSearch: "${def.key}" group failed — returning no hits for it`, err);
        return [];
    }
}
/**
 * Search everything for `q` across `groups`. Returns empty groups (in order) for a blank/too-short
 * query. Escapes the term once, runs every group in parallel, and isolates failures per group.
 */
export async function runSearch(q, groups, opts = {}) {
    const minLength = opts.minLength ?? SEARCH_MIN_TERM_LENGTH;
    const limit = opts.limit ?? 6;
    const term = q.trim();
    if (term.length < minLength)
        return emptyResults(groups);
    const ctx = { term, like: `%${escapeLike(term)}%`, limit };
    const hits = await Promise.all(groups.map((g) => runGroup(g, ctx)));
    const out = {};
    groups.forEach((g, i) => {
        out[g.key] = hits[i];
    });
    return out;
}
/** The non-empty groups of a result set, in the given render order (one source of truth for the
 *  dropdown and the /search page — pass the order derived from the app's groups array). */
export function nonEmptyGroups(r, order) {
    return order.filter((k) => r[k].length > 0);
}
/** Total hit count across all groups (for "N results" affordances). */
export function totalHits(r) {
    let n = 0;
    for (const k in r)
        n += r[k].length;
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
export function defineSearch(groups, defaults = {}) {
    const order = groups.map((g) => g.key);
    const titles = {};
    for (const g of groups)
        titles[g.key] = g.title;
    return {
        /** Render order of the groups (their array order). */
        order,
        /** Group key → section heading. */
        titles,
        /** An all-empty result set in order. */
        empty: () => emptyResults(groups),
        /** Run the search; per-call opts override this app's defaults. */
        search: (q, opts = {}) => runSearch(q, groups, { ...defaults, ...opts }),
        /** Non-empty groups in render order. */
        nonEmptyGroups: (r) => nonEmptyGroups(r, order),
        /** Total hits across groups. */
        totalHits,
    };
}

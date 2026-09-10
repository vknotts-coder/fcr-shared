// Saved custom-report persistence (#43 Slice 1). Per-user create/list/get/delete over fcr_core.saved_report
// with a dedupe-on-(owner,name,object) upsert + prune-to-cap guard. The stored `definition` is a validated
// ReportDefinition (jsonb) — validation happens in the action/runner against the viewer's registry, so a
// stale/invalid stored definition simply fails to run rather than corrupting anything.
//
// `shared` is share-ready plumbing: v1 always writes personal (shared=false). list/get already surface
// shared rows so an admin-published-report slice needs no data-layer change — only a write path that flips
// `shared` and a gate on who may publish. All writes soft-delete (deleted_at) per the fcr_core convention.
const MAX_SAVED_REPORTS = 50;
const MAX_NAME = 80;
function mapRow(r) {
    return {
        id: r.id,
        ownerAccountId: r.owner_account_id,
        name: r.name,
        objectKey: r.object_key,
        definition: r.definition,
        shared: r.shared,
        createdAt: String(r.created_at),
        updatedAt: String(r.updated_at),
    };
}
/** Reports visible to an account: their own + any shared. Newest-updated first, capped. */
export async function listSavedReports(db, accountId) {
    const { rows } = await db.query(`SELECT * FROM fcr_core.saved_report
      WHERE (owner_account_id = $1 OR shared = true) AND deleted_at IS NULL
      ORDER BY updated_at DESC
      LIMIT $2`, [accountId, MAX_SAVED_REPORTS]);
    return rows.map(mapRow);
}
/** One report IF the account may see it (owner OR shared). Null otherwise — never another user's private report. */
export async function getSavedReport(db, accountId, id) {
    const { rows } = await db.query(`SELECT * FROM fcr_core.saved_report WHERE id = $1 AND deleted_at IS NULL`, [id]);
    const r = rows[0];
    if (!r)
        return null;
    if (r.owner_account_id === accountId || r.shared)
        return mapRow(r);
    return null;
}
/**
 * Create/update a saved report for an account. Dedupes on (owner, name, object) via an ATOMIC upsert on
 * the partial-unique index — so a double-click / concurrent Save updates the existing row's definition
 * instead of racing two inserts into duplicate rows. Prunes the account's own reports beyond the cap.
 */
export async function saveReport(db, accountId, input) {
    const name = input.name.trim().slice(0, MAX_NAME) || "Untitled report";
    const definition = JSON.stringify(input.definition);
    const { rows } = await db.query(`INSERT INTO fcr_core.saved_report (owner_account_id, name, object_key, definition)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (owner_account_id, name, object_key) WHERE deleted_at IS NULL
     DO UPDATE SET definition = EXCLUDED.definition, updated_at = now()
     RETURNING *`, [accountId, name, input.objectKey, definition]);
    // Prune the account's own reports beyond the cap (soft-delete; shared visibility unaffected).
    await db.query(`UPDATE fcr_core.saved_report SET deleted_at = now(), updated_at = now()
      WHERE owner_account_id = $1 AND deleted_at IS NULL
        AND id NOT IN (
          SELECT id FROM fcr_core.saved_report
           WHERE owner_account_id = $1 AND deleted_at IS NULL
           ORDER BY updated_at DESC LIMIT $2
        )`, [accountId, MAX_SAVED_REPORTS]);
    const saved = rows[0];
    if (!saved)
        throw new Error("saveReport: upsert returned no row");
    return mapRow(saved);
}
/** Owner-scoped soft delete — a wrong id/owner is a no-op, never touches another user's report. */
export async function deleteSavedReport(db, accountId, id) {
    await db.query(`UPDATE fcr_core.saved_report SET deleted_at = now(), updated_at = now()
      WHERE id = $1 AND owner_account_id = $2 AND deleted_at IS NULL`, [id, accountId]);
}

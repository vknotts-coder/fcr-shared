// Report-registry CORE — the app-agnostic half of the registry (#99 Slice A: registry inversion, the
// prework that makes the engine liftable into @fcr/core/reports). This holds the registry TYPES and the
// generic gating/lookup helpers that are pure over a catalog + the shared RBAC can(); the app-specific
// reportable-object CATALOG (the truck/trailer definitions + REPORT_OBJECTS) stays in ./registry.
//
// Nothing here imports an app module: can() comes from @fcr/core/rbac (already shared), Principal from
// @fcr/core/contracts, and the field/client types from ./definition (itself app-agnostic). The catalog is
// passed IN (getObjectDef/objectsForViewer take it as a parameter) rather than imported, mirroring how the
// runner takes an injected db: Queryable — so this file lifts into @fcr/core/reports unchanged in Slice B.
//
// GATING (both through the shared can()):
//   • OBJECT gate (`capability`) — may this principal report on the object at all (v1 admin-only).
//   • FIELD gate — each `sensitive` field is offered only when can('view', <objectKey>, {section, field})
//     allows. Because toClientObject drops a denied field, the validator + runner + CSV never surface it.
import { can } from "../rbac/index.js";
// ── Gating predicates ──────────────────────────────────────────────────────────────────────────────
/** The same admin derivation auth.ts uses for isAdmin: a coarse ('*','admin','all') grant. v1 report
 *  access is admin-only, so this is both the object gate and (for now) the sensitive-field gate. */
export const isAdmin = (p) => can(p, "admin", "*").allowed;
/** Whether one sensitive field is offered to this principal — the per-field RBAC gate.
 *  can() DEFAULT-DENYs, so a field is offered only when a grant covers it: admin's wildcard (section/
 *  field NULL) covers every field (inert for admins), a can('view', <obj>, {section, field}) grant
 *  authorizes exactly this field, and a matching deny (DENY-WINS) hides it. */
function sensitiveFieldAllowed(obj, field, principal) {
    return can(principal, "view", obj.key, { section: field.section, field: field.key }).allowed;
}
/**
 * The client-safe, permission-FILTERED view of one object for a principal: strips server-only wiring
 * (path/sensitive) and DROPS sensitive fields the principal may not see. Because the validator checks a
 * definition against exactly this field set, a field not returned here can never be selected, filtered,
 * grouped, summarized, or sorted — the field-level security floor.
 */
export function toClientObject(obj, principal) {
    const fields = obj.fields
        .filter((fld) => !fld.sensitive || sensitiveFieldAllowed(obj, fld, principal))
        .map((fld) => ({
        key: fld.key,
        label: fld.label,
        type: fld.type,
        filterable: fld.filterable,
        groupable: fld.groupable,
        summable: fld.summable,
        ...(fld.enumValues ? { enumValues: fld.enumValues } : {}),
    }));
    return { key: obj.key, label: obj.label, description: obj.description, fields };
}
/** Every object in `catalog` this principal may report on, as client-safe filtered metadata (builder UI). */
export function objectsForViewer(catalog, principal) {
    return catalog.filter((obj) => obj.capability(principal)).map((obj) => toClientObject(obj, principal));
}
/** The full server-side object def for the runner, looked up in `catalog`. Undefined for an unknown key. */
export function getObjectDef(catalog, key) {
    return catalog.find((obj) => obj.key === key);
}

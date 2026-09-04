// @fcr/core/contracts — RBAC shapes (Module 1 identity/permissions), lifted from
// fcr-dispatch src/contracts/rbac.ts (frozen there for v1). This is now the single
// shared definition every fcr-* app speaks. Post-freeze changes are ADDITIVE-ONLY and
// version-bumped by a git tag on this repo (see fcr-dispatch#59).
//
// Modelling (settled by Robert, SCOPE.md §1): permissions flow ONLY through
// role → permission (never employee.job_title). A principal's effective set is the
// UNION across all their assignments' roles. Evaluation is deny-wins, default-deny.
// `field` is NULL in v1 (section-level policy); the shape is field-capable for later.
export {};

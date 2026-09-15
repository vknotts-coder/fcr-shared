// Shared intake types — the contract between the generic write pipeline (pipeline.ts) and a
// per-unit-type spec (specs/trailer, specs/truck). Kept React-free and DB-driver-free; the
// pipeline talks to the DB only through the injected `Queryable` seam (same as rbac/events).
export {};

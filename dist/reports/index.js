// @fcr/core/reports — the app-agnostic report engine, lifted from fcr-dispatch (#99 Slice B).
//
// What's here (portable): the report DEFINITION vocabulary + validator + filter-logic parser
// (definition), the SQL builder + validator + runner (runner), the registry TYPES + gating/lookup
// helpers over an injected catalog (registry-core), CSV serialization (csv), the canned-report
// framework (canned/framework), and saved-report persistence over an injected `db: Queryable`
// (savedReports). RBAC + types come from @fcr/core/rbac + @fcr/core/contracts.
//
// What stays PER-APP (each consumer supplies it): the reportable-object CATALOG (its own
// registry.ts building RegistryObject[] — dispatch's truck/trailer, trailers' trailer, …), its
// canned/*.ts queries, and the routes/UI wiring that injects the app's pool() + principal + catalog.
// runReport/validateReport take the catalog as a parameter; savedReports takes db as a parameter —
// so nothing here imports an app module or a DB driver.
export * from "./definition.js";
export * from "./dates.js";
export * from "./registry-core.js";
export * from "./runner.js";
export * from "./csv.js";
export * from "./savedReports.js";
export * from "./canned/framework.js";

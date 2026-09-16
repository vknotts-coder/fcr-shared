// Shared intake types — the contract between the generic write pipeline (pipeline.ts) and a
// per-unit-type spec (specs/trailer, specs/truck). Kept React-free and DB-driver-free; the
// pipeline talks to the DB only through the injected `Queryable` seam (same as rbac/events).

import type { SectionKey } from "./sections.js";

export type InputKind = "text" | "textarea" | "date" | "number" | "select";

export interface FormField {
  /** A real fcr_core column on the unit's table. */
  column: string;
  label: string;
  section: SectionKey;
  input: InputKind;
  /** Options for a select (first entry "" renders as a blank choice). */
  options?: string[];
}

export interface ValidationError {
  field: string | null;
  message: string;
}

/** What the pure status engine derives from the before-row + submitted edits. */
export interface EngineResult {
  /** Fields the engine derived (status, status_date, back-filled dates, completion %,
   *  sf_name on rework). Merge these over the user's submitted edits before writing. */
  derived: Record<string, unknown>;
  statusChanged: boolean;
  fromStatus: string | null;
  toStatus: string | null;
  /** SF EmailAlert names for this transition — the CONSUMING APP decides whether/how to send
   *  (the package never sends mail; keeps `next`/Resend out of core). Empty for trucks today. */
  emails: string[];
}

/** A possible-duplicate unit found by the dedupe guard. */
export interface DuplicateHit {
  unitType: string;
  id: string;
  sfName: string | null;
  /** Which key matched — "vin" or "name". */
  matchedOn: "vin" | "name";
}

export interface Actor {
  username: string;
  name: string;
}

/** A new customer to create inline (the fields fcr-sales collects). Only `sfName` is required;
 *  the created row's Salesforce id is NULL until reverse-sync pushes it — see resolveCustomerRef. */
export interface NewCustomerInput {
  sfName: string;
  businessPhone?: string | null;
  billingStreet?: string | null;
  billingCity?: string | null;
  billingState?: string | null;
  billingZip?: string | null;
}

/** A new contact to create inline, linked to the resolved customer ref (sf_id or local UUID). */
export interface NewContactInput {
  sfName: string;
  phone?: string | null;
  email?: string | null;
  role?: string | null;
}

/** Pick an existing customer (by its Salesforce id) OR create a new one inline. */
export type CustomerInput = { existingSfId: string } | { newCustomer: NewCustomerInput };

/** Pick an existing contact (by ref — its sf_id or local UUID) OR create a new one inline. */
export type ContactInput = { existingRef: string } | { newContact: NewContactInput };

/** Result of a create-multiple batch: the resolved customer/contact refs plus one entry per unit,
 *  in submit order. A unit entry is either a created id or the failure (validation errors / dedupe
 *  hits) from createUnit. Partial success is possible in v1 (sequential, non-atomic — matches the
 *  fcr-sales flow this is lifted from); the customer/contact are resolved once and shared. */
export interface BatchUnitResult {
  index: number;
  result: SaveResult;
}
export interface CreateUnitsResult {
  customerRef: string;
  contactRef: string;
  units: BatchUnitResult[];
  /** True iff every unit was created. */
  ok: boolean;
}

/**
 * A unit-type intake spec. The trailer spec is lifted from fcr-trailers verbatim; the truck
 * spec is create + a simple pickup seed-status (the full truck SF flow is a deferred slice —
 * no spec exists locally). All functions are PURE (no I/O): the pipeline supplies DB access.
 */
export interface IntakeSpec {
  /** "truck" | "trailer" — the event resourceType and the form metadata tag. */
  unitType: string;
  /** The fcr_core table name (unqualified): "truck" | "trailer". Trusted (not user input). */
  table: string;
  formFields: FormField[];
  numericCols: Set<string>;
  dateCols: Set<string>;
  /** Boolean columns edited via a Yes/No select — coerced to real true/false/null. Optional
   *  (only trailer has one today: `rework`); an absent set means no boolean coercion. */
  boolCols?: Set<string>;
  /** Extra bookkeeping columns kept out of the audit diff (id/created_by/... are always excluded). */
  diffExclude?: Set<string>;
  /** Soft-FK reference columns to existence-check against fcr_core.<table> by sf_id. */
  references?: { column: string; table: string; label: string }[];
  /** VIN column on this unit's table ("vin" | "full_vin") — used by the dedupe guard. */
  vinColumn: string;
  /** Unit-number/name column ("sf_name") — used by the dedupe guard. */
  nameColumn: string;
  /** The unit's customer/account ref column (truck: "fcr_collision_customer", trailer:
   *  "fcr_collision_account"). The create-multiple batch injects the resolved customer ref here.
   *  Holds either an existing customer's sf_id OR a just-created customer's local UUID. */
  customerRefColumn: string;
  /** The unit's contact ref column (truck: "fcr_collision_contacts", trailer:
   *  "fcr_collision_contact"). The batch injects the resolved contact ref here (sf_id or UUID). */
  contactRefColumn: string;
  /** Pure status engine: (before, edits, opts) → derived fields to merge into the write. */
  engine: (
    before: Record<string, unknown>,
    edits: Record<string, unknown>,
    opts: { isNew?: boolean; today?: string },
  ) => EngineResult;
  /** Pure validation over the effective after-state. */
  validate: (state: Record<string, unknown>, opts: { isNew?: boolean }) => ValidationError[];
}

export type SaveResult =
  | { ok: true; id: string; emails: string[] }
  | { ok: false; errors: ValidationError[] }
  | { ok: false; duplicates: DuplicateHit[] };

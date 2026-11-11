// Donor (salvage truck) reportable-object catalog — fcr-estimating#41 Slice 6. The SCHEMA half of the
// donor object (table/baseWhere/fields) lives here, shared like truck.ts/trailer.ts so the record app and
// any future consumer report off ONE definition. The app injects the app-specific half (the object gate +
// detail-page routing) via DonorObjectOptions, exactly as truckObject does.
//
// Donor is APP-OWNED salvage stock (no Salesforce sync, no sf_id) — FCR's own wrecks bought to part out.
// Columns verified against fcr-dispatch/migrations/202611111400_donor_tables.sql. The money columns are
// real numeric(12,2) (not SF-synced text), and the per-donor money roll-ups are correlated subqueries over
// fcr_core.donor_ledger (one-to-many → a JOIN would multiply base rows), mirroring computeDonorFinancials
// in the app's donor/read.ts so the list-view/report money matches the record page exactly.

import type { Principal } from "../contracts/index.js";
import type { RegistryField, RegistryObject } from "../reports/registry-core.js";
import { str, dateF, dateTzF, numF, money, bool, computed } from "./fields.js";
import { donorStatusField } from "./status-order.js";

// Yard rate per mile — the estimating app's app_setting, falling back to the $1.50 source default. Donor is
// estimating-owned, so the (app_key='estimating') scope is intentional even though this catalog lives in
// @fcr/core: it is only ever registered by fcr-estimating. Kept in sync with donor/settings.ts.
const YARD_RATE =
  "COALESCE((SELECT s.value::numeric FROM fcr_core.app_setting s " +
  "WHERE s.app_key = 'estimating' AND s.key = 'donor_yard_rate_per_mile'), 1.5)";
// Resolved recovery cost: the flat recovery_cost when entered, else miles × yard rate.
const RECOVERY = `CASE WHEN donor.recovery_cost > 0 THEN donor.recovery_cost ELSE donor.recovery_miles * ${YARD_RATE} END`;
// Per-donor ledger roll-ups. Correlated subqueries keep the donor grain (donor_ledger is one-to-many);
// soft-deleted ledger lines are excluded. amount is always positive — `kind` carries the sign.
const CREDITS =
  "COALESCE((SELECT SUM(l.amount) FROM fcr_core.donor_ledger l " +
  "WHERE l.donor_id = donor.id AND l.kind = 'credit' AND l.deleted_at IS NULL), 0)";
const COSTS =
  "COALESCE((SELECT SUM(l.amount) FROM fcr_core.donor_ledger l " +
  "WHERE l.donor_id = donor.id AND l.kind = 'cost' AND l.deleted_at IS NULL), 0)";
// `saved` is reporting-only (retail a pulled part let FCR avoid) — it NEVER touches the balance.
const SAVED =
  "COALESCE((SELECT SUM(l.saved) FROM fcr_core.donor_ledger l " +
  "WHERE l.donor_id = donor.id AND l.deleted_at IS NULL), 0)";
// Balance = credits − (purchase + resolved recovery + ledger costs). Positive ⇒ the donor has paid itself
// back and then some. Matches computeDonorFinancials (donor/read.ts).
const BALANCE = `${CREDITS} - donor.purchase_cost - (${RECOVERY}) - ${COSTS}`;

/** The donor object's field table (schema-coupled; shared across consumers). */
export const donorFields: RegistryField[] = [
  // Identity
  str("unit", "Unit #", "identity"),
  // Stage (slug stored; rendered as a label, sorted by yard flow — see donorStatusField).
  donorStatusField(),
  str("year", "Year", "identity"),
  str("make", "Make", "identity"),
  str("model", "Model", "identity"),
  str("vin", "VIN", "identity"),
  str("color", "Color", "identity"),
  str("engine", "Engine", "identity"),
  str("mileage", "Mileage", "identity"),
  str("location", "Yard location", "identity"),
  str("notes", "Notes", "identity"),
  // Acquisition
  str("source", "Source", "acquisition"),
  str("pickup_from", "Recovered from", "acquisition"),
  dateF("acquired_at", "Acquired", "acquisition"),
  numF("recovery_miles", "Recovery miles", "acquisition"),
  // Lifecycle
  bool("archived", "Depleted", "status"),
  dateTzF("archived_at", "Depleted on", "status"),
  dateTzF("created_at", "Created", "status"),
  dateTzF("updated_at", "Updated", "status"),
  // Financials (sensitive — donor money is internal cost; gated per-field like truck financials)
  money("purchase_cost", "Purchase cost", "financials"),
  money("recovery_cost", "Recovery cost (flat)", "financials"),
  computed("money", "recovery_total", "Recovery (effective)", "financials", RECOVERY, { sensitive: true }),
  computed("money", "ledger_credits", "Parts sold (credits)", "financials", CREDITS, { sensitive: true, summable: true }),
  computed("money", "ledger_costs", "Added costs", "financials", COSTS, { sensitive: true, summable: true }),
  computed("money", "net_balance", "Net balance", "financials", BALANCE, { sensitive: true, summable: true }),
  computed("money", "ledger_saved", "Retail saved", "financials", SAVED, { sensitive: true, summable: true }),
];

export type DonorObjectOptions = {
  /** Object gate — may this principal report on donors at all. Required (see truck.ts header). */
  capability: (p: Principal) => boolean;
  /** Detail-page hyperlink for tabular rows (app routing). */
  link?: { path: string; href: (id: string) => string };
  /** Optional per-run gate for `link`. Absent ⇒ link always active. */
  linkEnabled?: () => boolean;
  /** Row-level owner column; null ⇒ shared data (v1 default). */
  ownerField?: string | null;
  /** Row-scope widening predicate (forward hook for per-owner objects). */
  seesAllCapability?: (p: Principal) => boolean;
};

/** Build the donor RegistryObject, injecting the app's gate + routing. No join — the money roll-ups are
 *  correlated subqueries (see the expr consts above), so the object is single-table. */
export function donorObject(opts: DonorObjectOptions): RegistryObject {
  return {
    key: "donor",
    label: "Salvage Donors",
    description: "FCR salvage/donor trucks bought to part out — money, take-off, and history. App-owned (no Salesforce sync).",
    table: "fcr_core.donor",
    baseWhere: "donor.deleted_at IS NULL",
    capability: opts.capability,
    ownerField: opts.ownerField ?? null,
    seesAllCapability: opts.seesAllCapability,
    link: opts.link,
    linkEnabled: opts.linkEnabled,
    fields: donorFields,
  };
}

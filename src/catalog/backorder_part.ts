// Back-order-parts reportable-object catalog (fcr-parts epic #18 S2). The SCHEMA half (table/join/baseWhere/
// fields) of the `truck_backorder_part` object lives here so every app shares ONE definition; the app-specific
// half (capability gate, detail-page link) is injected, exactly like truckObject()/donorObject().
//
// GRAIN = one back-order-part row (truck_backorder_part), NOT the truck. A part is linked to its truck via
// `unit_number = truck.sf_id` (the SF id), so the object LEFT JOINs truck to carry the human truck name
// (`truck_name`) — `unit_number` itself is the raw SF id, not display-friendly. The join excludes deleted/test
// trucks in its ON clause, and baseWhere drops a part whose linked truck is a test truck while keeping an
// unlinked part (truck.id IS NULL) — the same visibility contract the fcr-parts header search applies.
//
// Column paths verified against fcr_core.truck_backorder_part (information_schema, 2026-11-19): part_1/2 +
// _description, po_number, paragon_number, fcr_order_tolas, parts_in_stock_yes_no are varchar; sf_name varchar;
// estimated_arrival_date / all_parts_received_date are `date`; created_at/updated_at timestamptz. NO financial
// columns exist on this object, so nothing here is sensitive/field-gated.
//
// PURE module — types + data only, no server/DB import; safe in any bundle.

import type { Principal } from "../contracts/index.js";
import type { RegistryField, RegistryObject } from "../reports/registry-core.js";
import { str, dateF, dateTzF, bool, computed, tzToday } from "./fields.js";

/** The back-order-part object's field table (schema-coupled; identical across apps). */
export const backorderPartFields: RegistryField[] = [
  // The truck this part is on — the human name via the join (unit_number is the raw SF id).
  str("truck_name", "Truck", "identity", "truck.sf_name"),
  // Part record name (SF Name) + the two part slots the truck object carries.
  str("sf_name", "Part record", "identity"),
  str("part_1", "Part 1", "parts"),
  str("part_1_description", "Part 1 description", "parts"),
  str("part_2", "Part 2", "parts"),
  str("part_2_description", "Part 2 description", "parts"),
  // Ordering / status
  str("po_number", "PO #", "ordering"),
  str("paragon_number", "Paragon #", "ordering"),
  str("fcr_order_tolas", "FCR order / TOLAS", "ordering"),
  str("parts_in_stock_yes_no", "In stock", "ordering"),
  dateF("estimated_arrival_date", "ETA", "ordering"),
  dateF("all_parts_received_date", "Received", "ordering"),
  // Lifecycle
  dateTzF("created_at", "Created", "status"),
  dateTzF("updated_at", "Updated", "status"),
  // COMPUTED — "overdue": an OPEN part (not fully received) whose ETA is before today. A registry-authored
  // boolean so the Overdue view filters on a static `eq true` (ReportFilter values are static, can't hold
  // "today"); the tz basis matches every other now()-relative field. Qualify columns with the base alias.
  computed("boolean", "is_overdue", "Overdue", "ordering",
    `(backorder_part.all_parts_received_date IS NULL AND backorder_part.estimated_arrival_date IS NOT NULL AND backorder_part.estimated_arrival_date < ${tzToday})`),
  // COMPUTED — days a part has been open (for aging). NULL once received. Display-only (not summable).
  computed("number", "days_open", "Days open", "status",
    `CASE WHEN backorder_part.all_parts_received_date IS NULL THEN (${tzToday} - backorder_part.created_at::date) END`),
];

export interface BackorderPartObjectOptions {
  /** Object gate (the consuming app supplies it; e.g. `() => true` for authed parts staff). REQUIRED. */
  capability: (p: Principal) => boolean;
  ownerField?: string | null;
  seesAllCapability?: (p: Principal) => boolean;
  link?: RegistryObject["link"];
  linkEnabled?: RegistryObject["linkEnabled"];
}

export function backorderPartObject(opts: BackorderPartObjectOptions): RegistryObject {
  return {
    key: "backorder_part",
    label: "Back-order parts",
    description: "Truck back-order parts — ordering, ETA, and receipt. The fcr-parts lane. View-only.",
    table: "fcr_core.truck_backorder_part",
    // truck.sf_id is the SF id this part links to; UNIQUE (truck_backorder_part_sf_id_key is on the part, and
    // truck.sf_id is unique), so one-to-one — no row multiplication. Deleted/test trucks excluded in the ON.
    join: { alias: "truck", sql: "LEFT JOIN fcr_core.truck truck ON truck.sf_id = backorder_part.unit_number AND truck.deleted_at IS NULL AND truck.is_test = false" },
    // Keep a part whose linked truck is a test truck OUT (parity with the truck baseWhere is_test = false),
    // but keep an UNLINKED part (no matching truck → truck.id IS NULL) visible.
    baseWhere: "backorder_part.deleted_at IS NULL AND (truck.id IS NULL OR truck.is_test = false)",
    capability: opts.capability,
    ownerField: opts.ownerField ?? null,
    seesAllCapability: opts.seesAllCapability,
    link: opts.link,
    linkEnabled: opts.linkEnabled,
    fields: backorderPartFields,
  };
}

// Inline customer/contact creation for intake — lifted from fcr-sales' resolveCustomerRef/
// resolveContactRef (src/app/intake/new/actions.ts) and routed through the event-log chokepoint
// (commitWithEvent) so every app that creates a customer/contact gets the audit trail sales lacked.
//
// ⚠ THE UUID-REF CONVENTION (load-bearing — do not "fix" it away): a NEW customer/contact is
// inserted with sf_id NULL, so a unit can't store its Salesforce id yet. Instead the unit stores
// the new row's LOCAL UUID in its customer/contact ref column as a placeholder; dispatch's
// reverse-sync pushes the customer to the real SF org first (PUSH_ORDER: customer → contact →
// unit) and resolves the UUID → the real SF Id at push time. So a ref column holds EITHER an
// existing row's sf_id OR a pending local UUID. checkReferences (pipeline.ts) is UUID-aware to
// match. This is the exact mechanism fcr-sales already runs in prod.
//
// Each `build*Insert` returns the ref plus (for a NEW row) the built INSERT+event statement WITHOUT
// executing it, so createUnits can run the whole batch (customer + contact + N units) inside ONE
// TxRunner transaction (fcr-shared#22 batch atomicity). resolveCustomerRef/resolveContactRef keep
// their execute-immediately behavior for the single-write / sequential-fallback paths.

import { randomUUID } from "node:crypto";
import { eventInsert, diffChanges } from "../events/index.js";
import { isBlank } from "./coerce.js";
import type { Queryable, Statement } from "../rbac/index.js";
import type { Actor, CustomerInput, ContactInput } from "./types.js";

// Trim to a stored value or null — reuses coerce.ts's isBlank so blank semantics can't drift.
const nn = (v: string | null | undefined): string | null => (isBlank(v) ? null : (v as string).trim());

/**
 * Find an existing, NOT-yet-synced customer with the same name to reuse instead of inserting a
 * duplicate (fcr-shared#22 companion). Scoped deliberately to `sf_id IS NULL` (a pending local
 * customer): it de-dupes a same-name re-entry from before reverse-sync ran, but NEVER silently
 * merges two distinct real Salesforce accounts that happen to share a name. Case-insensitive on
 * the trimmed name; most recent wins. Returns the customer's LOCAL UUID ref, or null.
 */
export async function findUnsyncedCustomerByName(sfName: string, db: Queryable): Promise<string | null> {
  const name = sfName.trim();
  if (!name) return null;
  const { rows } = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM fcr_core.customer
     WHERE sf_id IS NULL AND lower(btrim(sf_name)) = lower($1)
       AND deleted_at IS NULL
     ORDER BY created_at DESC NULLS LAST LIMIT 1`,
    [name],
  );
  return rows[0]?.id ?? null;
}

/** Build the customer resolution: an existing ref unchanged (no statement), or a new
 *  fcr_core.customer row's LOCAL UUID + the built INSERT+event statement (not yet executed). */
export async function buildCustomerInsert(input: CustomerInput, actor: Actor): Promise<{ ref: string; statement?: Statement }> {
  if ("existingSfId" in input) return { ref: input.existingSfId };
  const c = input.newCustomer;
  const id = randomUUID();
  const cols: Record<string, unknown> = {
    id,
    sf_name: c.sfName.trim(),
    business_phone: nn(c.businessPhone),
    billing_street_address: nn(c.billingStreet),
    billing_city: nn(c.billingCity),
    billing_state: nn(c.billingState),
    billing_zip_code: nn(c.billingZip),
    created_by: actor.name,
    updated_by: actor.name,
  };
  const changes = diffChanges({}, cols, { numericCols: new Set(), dateCols: new Set(), exclude: new Set(["id", "created_by", "updated_by"]) });
  const keys = Object.keys(cols);
  const placeholders = keys.map((_, i) => `$${i + 1}`);
  const { text, params } = await eventInsert(
    { source: "app", resourceType: "customer", resourceId: id, action: "create", actor: { label: actor.name }, changes, metadata: { form: "customer" } },
    {
      text: `INSERT INTO fcr_core.customer (${keys.join(", ")}, created_at, updated_at)
             VALUES (${placeholders.join(", ")}, NOW(), NOW())`,
      params: keys.map((k) => cols[k]),
    },
  );
  return { ref: id, statement: { text, params } };
}

/** Build the contact resolution: an existing ref unchanged (no statement), or a new
 *  fcr_core.unit_contact row's LOCAL UUID + the built INSERT+event statement (linked to customerRef). */
export async function buildContactInsert(input: ContactInput, customerRef: string, actor: Actor): Promise<{ ref: string; statement?: Statement }> {
  if ("existingRef" in input) return { ref: input.existingRef };
  const c = input.newContact;
  const id = randomUUID();
  const cols: Record<string, unknown> = {
    id,
    sf_name: c.sfName.trim(),
    fcr_collision_account: customerRef,
    phone: nn(c.phone),
    email_address: nn(c.email),
    contact_role: nn(c.role),
    status: "Active",
    created_by_name: actor.name,
  };
  const changes = diffChanges({}, cols, { numericCols: new Set(), dateCols: new Set(), exclude: new Set(["id", "created_by_name"]) });
  const keys = Object.keys(cols);
  const placeholders = keys.map((_, i) => `$${i + 1}`);
  const { text, params } = await eventInsert(
    { source: "app", resourceType: "unit_contact", resourceId: id, action: "create", actor: { label: actor.name }, changes, metadata: { form: "unit_contact" } },
    {
      text: `INSERT INTO fcr_core.unit_contact (${keys.join(", ")}, created_at, updated_at)
             VALUES (${placeholders.join(", ")}, NOW(), NOW())`,
      params: keys.map((k) => cols[k]),
    },
  );
  return { ref: id, statement: { text, params } };
}

/**
 * Resolve the customer for an intake: return an existing customer's ref unchanged, or create a new
 * fcr_core.customer row (audited) and return its LOCAL UUID. Executes immediately (single-write /
 * sequential-fallback path); createUnits' transactional path uses buildCustomerInsert instead.
 */
export async function resolveCustomerRef(input: CustomerInput, actor: Actor, db: Queryable): Promise<string> {
  const { ref, statement } = await buildCustomerInsert(input, actor);
  if (statement) await db.query(statement.text, statement.params);
  return ref;
}

/**
 * Resolve the contact for an intake: return an existing contact's ref unchanged, or create a new
 * fcr_core.unit_contact row (audited) linked to `customerRef` and return its LOCAL UUID. Executes
 * immediately; createUnits' transactional path uses buildContactInsert instead.
 */
export async function resolveContactRef(input: ContactInput, customerRef: string, actor: Actor, db: Queryable): Promise<string> {
  const { ref, statement } = await buildContactInsert(input, customerRef, actor);
  if (statement) await db.query(statement.text, statement.params);
  return ref;
}

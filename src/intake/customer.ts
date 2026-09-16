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

import { randomUUID } from "node:crypto";
import { commitWithEvent, diffChanges } from "../events/index.js";
import type { Queryable } from "../rbac/index.js";
import type { Actor, CustomerInput, ContactInput } from "./types.js";

const nn = (v: string | null | undefined): string | null => {
  if (typeof v !== "string") return v ?? null;
  const t = v.trim();
  return t.length ? t : null;
};

/**
 * Resolve the customer for an intake: return an existing customer's Salesforce id unchanged, or
 * create a new fcr_core.customer row (audited) and return its LOCAL UUID (reverse-sync resolves it
 * to the SF Id later — see the file header). Caller must ensure a new customer's `sfName` is present.
 */
export async function resolveCustomerRef(input: CustomerInput, actor: Actor, db: Queryable): Promise<string> {
  if ("existingSfId" in input) return input.existingSfId;
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
  await commitWithEvent(
    { source: "app", resourceType: "customer", resourceId: id, action: "create", actor: { label: actor.name }, changes, metadata: { form: "customer" } },
    {
      text: `INSERT INTO fcr_core.customer (${keys.join(", ")}, created_at, updated_at)
             VALUES (${placeholders.join(", ")}, NOW(), NOW())`,
      params: keys.map((k) => cols[k]),
    },
    db,
  );
  return id;
}

/**
 * Resolve the contact for an intake: return an existing contact's ref (sf_id or UUID) unchanged, or
 * create a new fcr_core.unit_contact row (audited) linked to `customerRef` (the just-resolved
 * customer's sf_id or local UUID) and return its LOCAL UUID. Caller must ensure a new contact's
 * `sfName` is present.
 */
export async function resolveContactRef(input: ContactInput, customerRef: string, actor: Actor, db: Queryable): Promise<string> {
  if ("existingRef" in input) return input.existingRef;
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
  await commitWithEvent(
    { source: "app", resourceType: "unit_contact", resourceId: id, action: "create", actor: { label: actor.name }, changes, metadata: { form: "unit_contact" } },
    {
      text: `INSERT INTO fcr_core.unit_contact (${keys.join(", ")}, created_at, updated_at)
             VALUES (${placeholders.join(", ")}, NOW(), NOW())`,
      params: keys.map((k) => cols[k]),
    },
    db,
  );
  return id;
}

import { describe, it, expect } from "vitest";
import { can } from "./index.js";
import type { GrantedPermission, Principal, Scope, Effect } from "../contracts/index.js";

// Build a grant with sensible defaults; override only what a case exercises.
function grant(p: Partial<GrantedPermission> = {}): GrantedPermission {
  return {
    roleId: "",
    resourceType: p.resourceType ?? "truck",
    action: p.action ?? "view",
    section: p.section ?? null,
    field: p.field ?? null,
    scope: (p.scope ?? "all") as Scope,
    effect: (p.effect ?? "allow") as Effect,
    departmentId: p.departmentId ?? null,
    shopId: p.shopId ?? null,
  };
}
function principal(grants: GrantedPermission[], accountId: string | null = "acct-1"): Principal {
  return { username: "u", accountId, grants };
}

describe("can() — default-deny / allow / deny-wins", () => {
  it("default-denies with no grants", () => {
    const d = can(principal([]), "view", "truck");
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("default-deny");
  });

  it("allows on a matching allow grant", () => {
    expect(can(principal([grant()]), "view", "truck").allowed).toBe(true);
  });

  it("deny-wins over a matching allow", () => {
    const p = principal([grant({ effect: "allow" }), grant({ effect: "deny" })]);
    const d = can(p, "view", "truck");
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("deny-wins");
  });

  it("does not match a different resourceType/action", () => {
    const p = principal([grant({ resourceType: "truck", action: "view" })]);
    expect(can(p, "view", "trailer").allowed).toBe(false);
    expect(can(p, "edit", "truck").allowed).toBe(false);
  });
});

describe("can() — wildcards", () => {
  it('"*" resourceType and action both match', () => {
    const p = principal([grant({ resourceType: "*", action: "*" })]);
    expect(can(p, "anything", "whatever").allowed).toBe(true);
  });
});

describe("can() — section policy", () => {
  it("a whole-resource grant (section null) satisfies a section-specific check", () => {
    const p = principal([grant({ section: null })]);
    expect(can(p, "view", "truck", { section: "financials" }).allowed).toBe(true);
  });

  it("a section-specific grant does NOT satisfy a broader whole-resource check", () => {
    const p = principal([grant({ section: "financials" })]);
    expect(can(p, "view", "truck").allowed).toBe(false); // wantSection null, grant section 'financials'
  });

  it("a section-specific grant matches its own section, denies another", () => {
    const p = principal([grant({ section: "financials" })]);
    expect(can(p, "view", "truck", { section: "financials" }).allowed).toBe(true);
    expect(can(p, "view", "truck", { section: "internal" }).allowed).toBe(false);
  });
});

describe("can() — scope evaluation", () => {
  it("scope 'all' is always satisfied", () => {
    expect(can(principal([grant({ scope: "all" })]), "view", "truck").allowed).toBe(true);
  });

  it("scope 'department' matches only the granting department", () => {
    const p = principal([grant({ scope: "department", departmentId: "d1" })]);
    expect(can(p, "view", "truck", { resource: { departmentId: "d1" } }).allowed).toBe(true);
    expect(can(p, "view", "truck", { resource: { departmentId: "d2" } }).allowed).toBe(false);
    expect(can(p, "view", "truck").allowed).toBe(false); // no resource context → unsatisfied
  });

  it("scope 'shop' matches only the granting shop", () => {
    const p = principal([grant({ scope: "shop", shopId: "s1" })]);
    expect(can(p, "view", "truck", { resource: { shopId: "s1" } }).allowed).toBe(true);
    expect(can(p, "view", "truck", { resource: { shopId: "s2" } }).allowed).toBe(false);
  });

  it("scope 'self' matches when the resource owner is the principal's account", () => {
    const p = principal([grant({ scope: "self" })], "acct-1");
    expect(can(p, "view", "truck", { resource: { ownerAccountId: "acct-1" } }).allowed).toBe(true);
    expect(can(p, "view", "truck", { resource: { ownerAccountId: "acct-2" } }).allowed).toBe(false);
  });

  it("scope 'self' is denied when the principal has no accountId", () => {
    const p = principal([grant({ scope: "self" })], null);
    expect(can(p, "view", "truck", { resource: { ownerAccountId: "acct-1" } }).allowed).toBe(false);
  });
});

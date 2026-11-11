import type { Principal } from "../contracts/index.js";
import type { RegistryField, RegistryObject } from "../reports/registry-core.js";
/** The donor object's field table (schema-coupled; shared across consumers). */
export declare const donorFields: RegistryField[];
export type DonorObjectOptions = {
    /** Object gate — may this principal report on donors at all. Required (see truck.ts header). */
    capability: (p: Principal) => boolean;
    /** Detail-page hyperlink for tabular rows (app routing). */
    link?: {
        path: string;
        href: (id: string) => string;
    };
    /** Optional per-run gate for `link`. Absent ⇒ link always active. */
    linkEnabled?: () => boolean;
    /** Row-level owner column; null ⇒ shared data (v1 default). */
    ownerField?: string | null;
    /** Row-scope widening predicate (forward hook for per-owner objects). */
    seesAllCapability?: (p: Principal) => boolean;
};
/** Build the donor RegistryObject, injecting the app's gate + routing. No join — the money roll-ups are
 *  correlated subqueries (see the expr consts above), so the object is single-table. */
export declare function donorObject(opts: DonorObjectOptions): RegistryObject;
//# sourceMappingURL=donor.d.ts.map
import type { Principal } from "../contracts/index.js";
import type { RegistryField, RegistryObject } from "../reports/registry-core.js";
/** The truck object's field table (schema-coupled; identical across apps). */
export declare const truckFields: RegistryField[];
export type TruckObjectOptions = {
    /** Object gate — may this principal report on trucks at all. Required (see file header). */
    capability: (p: Principal) => boolean;
    /** Detail-page hyperlink for tabular rows (app routing). */
    link?: {
        path: string;
        href: (id: string) => string;
    };
    /** Optional per-run gate for `link` (e.g. a cutover flag). Absent ⇒ link always active. */
    linkEnabled?: () => boolean;
    /** Row-level owner column; null ⇒ shared data (v1 default). */
    ownerField?: string | null;
    /** Row-scope widening predicate (forward hook for per-owner objects). */
    seesAllCapability?: (p: Principal) => boolean;
};
/** Build the truck RegistryObject, injecting the app's gate + routing. */
export declare function truckObject(opts: TruckObjectOptions): RegistryObject;
//# sourceMappingURL=truck.d.ts.map
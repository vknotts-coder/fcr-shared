import type { Principal } from "../contracts/index.js";
import type { RegistryField, RegistryObject } from "../reports/registry-core.js";
/** The trailer object's field table (schema-coupled; identical across apps). */
export declare const trailerFields: RegistryField[];
export type TrailerObjectOptions = {
    /** Object gate — may this principal report on trailers at all. Required (see truck.ts header). */
    capability: (p: Principal) => boolean;
    /** Detail-page hyperlink for tabular rows (app routing). The /records/trailer/[id] route is DARK behind
     *  a flag, so callers typically pass a `linkEnabled` that mirrors it. */
    link?: {
        path: string;
        href: (id: string) => string;
    };
    /** Optional per-run gate for `link` (e.g. RECORDS_TRAILER_LIVE). Absent ⇒ link always active. */
    linkEnabled?: () => boolean;
    /** Row-level owner column; null ⇒ shared data (v1 default). */
    ownerField?: string | null;
    /** Row-scope widening predicate (forward hook for per-owner objects). */
    seesAllCapability?: (p: Principal) => boolean;
};
/** Build the trailer RegistryObject, injecting the app's gate + routing. */
export declare function trailerObject(opts: TrailerObjectOptions): RegistryObject;
//# sourceMappingURL=trailer.d.ts.map
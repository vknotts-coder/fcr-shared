import type { Principal } from "../contracts/index.js";
import type { RegistryField, RegistryObject } from "../reports/registry-core.js";
/** The back-order-part object's field table (schema-coupled; identical across apps). */
export declare const backorderPartFields: RegistryField[];
export interface BackorderPartObjectOptions {
    /** Object gate (the consuming app supplies it; e.g. `() => true` for authed parts staff). REQUIRED. */
    capability: (p: Principal) => boolean;
    ownerField?: string | null;
    seesAllCapability?: (p: Principal) => boolean;
    link?: RegistryObject["link"];
    linkEnabled?: RegistryObject["linkEnabled"];
}
export declare function backorderPartObject(opts: BackorderPartObjectOptions): RegistryObject;
//# sourceMappingURL=backorder_part.d.ts.map
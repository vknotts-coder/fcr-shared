import type { RegistryField } from "../reports/registry-core.js";
export declare const TRUCK_STATUS_ORDER: string[];
export declare const TRAILER_STATUS_ORDER: string[];
export declare const DONOR_STATUS_ORDER: string[];
export declare const DONOR_STATUS_LABELS: Record<string, string>;
export declare const DONOR_STATUS_LABEL_ORDER: string[];
export declare function statusRankExpr(objKey: string, order: readonly string[]): string;
export declare function statusField(objKey: string, order: readonly string[]): RegistryField;
export declare function donorStatusField(): RegistryField;
//# sourceMappingURL=status-order.d.ts.map
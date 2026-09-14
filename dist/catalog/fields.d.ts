import { type FieldType } from "../reports/definition.js";
import type { RegistryField } from "../reports/registry-core.js";
export declare const f: (type: FieldType, key: string, label: string, section: string, opts?: {
    path?: string;
    filterable?: boolean;
    groupable?: boolean;
    summable?: boolean;
    sensitive?: boolean;
    enumValues?: string[];
}) => RegistryField;
export declare const str: (key: string, label: string, section: string, path?: string) => RegistryField;
export declare const dateF: (key: string, label: string, section: string, path?: string) => RegistryField;
export declare const dateTzF: (key: string, label: string, section: string, path?: string) => RegistryField;
export declare const numF: (key: string, label: string, section: string, path?: string) => RegistryField;
export declare const money: (key: string, label: string, section: string, sensitive?: boolean, path?: string) => RegistryField;
export declare const bool: (key: string, label: string, section: string, path?: string) => RegistryField;
export declare const tzToday = "timezone('America/Chicago', now())::date";
export declare const sfDuration: (endCol: string, startCol: string) => string;
export declare const computed: (type: FieldType, key: string, label: string, section: string, expr: string, opts?: {
    filterable?: boolean;
    groupable?: boolean;
    summable?: boolean;
    sensitive?: boolean;
}) => RegistryField;
//# sourceMappingURL=fields.d.ts.map
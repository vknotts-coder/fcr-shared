export type Queryable = {
    query: (text: string, params: unknown[]) => Promise<unknown>;
};
export declare function rowsOf<T>(raw: unknown): T[];
export declare function sanitizeFilename(name: string): string;
//# sourceMappingURL=seam.d.ts.map
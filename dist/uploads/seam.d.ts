export type Queryable = {
    query: (text: string, params: unknown[]) => Promise<unknown>;
};
export declare function rowsOf<T>(raw: unknown): T[];
//# sourceMappingURL=seam.d.ts.map
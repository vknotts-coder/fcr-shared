export type DownloadUrlResolver = (storedUrl: string) => Promise<string>;
export declare function streamBlob(storedUrl: string, opts: {
    contentType: string | null;
    fallbackType: string;
    filename?: string;
    resolveDownloadUrl?: DownloadUrlResolver;
}): Promise<Response>;
//# sourceMappingURL=proxy.d.ts.map
export type GenerateTokenConfig = {
    allowedContentTypes: string[];
    maximumSizeInBytes: number;
    addRandomSuffix: boolean;
    tokenPayload: string;
};
export type BeforeGenerateToken = (pathname: string, clientPayload: string | null) => Promise<GenerateTokenConfig>;
export declare function makeBeforeGenerateToken(authorize: () => Promise<void>): BeforeGenerateToken;
//# sourceMappingURL=token.d.ts.map
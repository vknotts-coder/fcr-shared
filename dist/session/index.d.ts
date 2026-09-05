import type { SessionOptions } from "iron-session";
/**
 * Resolve the iron-session signing key — FAIL CLOSED on any deployment.
 *
 * Local dev (no Vercel env) may use the committed fallback so `npm run dev` needs no setup.
 * But on ANY Vercel deployment (VERCEL / VERCEL_ENV set) a real SESSION_SECRET of at least
 * 32 chars is MANDATORY: signing cookies with the publicly-known fallback would let anyone
 * forge a session and walk past the login. Set a distinct SESSION_SECRET in every deployed
 * scope (Production, Preview, Development). Throws at call time (per request), not import, so
 * a build-time import of this module can't trip it.
 */
export declare function resolveSessionSecret(): string;
/**
 * Build the iron-session options for an app, given its cookie name. The signing secret is
 * resolved fail-closed (per call), and the cookie options are the fleet-standard set. Each
 * app passes the result to `getIronSession<AppSessionData>(await cookies(), sessionOptions(NAME))`.
 */
export declare function sessionOptions(cookieName: string): SessionOptions;
//# sourceMappingURL=index.d.ts.map
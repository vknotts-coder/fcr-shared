// @fcr/core/session — the security-critical session-config primitives shared across the
// fleet (fcr-dispatch#59 Slice D). Every app's session.ts had a byte-identical copy of the
// signing-secret resolution + cookie options, drifted only by the committed dev fallback —
// the exact thing this centralizes so it is fail-closed once, everywhere.
//
// Deliberately NOT coupled to Next: this module is pure `process.env` + a TYPE-ONLY import
// of iron-session's SessionOptions (erased at build — no runtime iron-session require). Each
// app keeps its own 2-line `getIronSession(await cookies(), sessionOptions(NAME))` wiring and
// its own `SessionData` type + cookie name; the package owns only the parts that must not drift.
// Committed dev fallback. ONLY ever used for local dev (`npm run dev`), where there is no
// deployment to expose it. iron-session requires >=32 chars.
const DEV_FALLBACK_SECRET = "change-me-in-env-dev-only-at-least-32-chars!!";
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
export function resolveSessionSecret() {
    const secret = process.env.SESSION_SECRET;
    const onVercel = !!(process.env.VERCEL || process.env.VERCEL_ENV);
    if (onVercel && (!secret || secret.length < 32)) {
        throw new Error("SESSION_SECRET is missing or shorter than 32 chars on a Vercel deployment. " +
            "Refusing to sign session cookies with the committed dev fallback — set a distinct " +
            "SESSION_SECRET (>=32 chars) in every deployed environment scope (Production, Preview, " +
            "Development).");
    }
    return secret || DEV_FALLBACK_SECRET;
}
/**
 * Build the iron-session options for an app, given its cookie name. The signing secret is
 * resolved fail-closed (per call), and the cookie options are the fleet-standard set. Each
 * app passes the result to `getIronSession<AppSessionData>(await cookies(), sessionOptions(NAME))`.
 */
export function sessionOptions(cookieName) {
    return {
        password: resolveSessionSecret(),
        cookieName,
        cookieOptions: {
            secure: process.env.NODE_ENV === "production",
            httpOnly: true,
            sameSite: "lax",
            path: "/",
            maxAge: 60 * 60 * 24 * 30,
        },
    };
}

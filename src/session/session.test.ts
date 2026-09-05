import { describe, it, expect, afterEach, vi } from "vitest";
import { resolveSessionSecret, sessionOptions } from "./index.js";

const VALID = "a".repeat(40); // >=32-char secret
const FALLBACK = "change-me-in-env-dev-only-at-least-32-chars!!";

afterEach(() => vi.unstubAllEnvs());

describe("resolveSessionSecret — fail closed on Vercel", () => {
  it("returns the committed fallback in local dev (no Vercel env, no secret)", () => {
    vi.stubEnv("SESSION_SECRET", "");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");
    expect(resolveSessionSecret()).toBe(FALLBACK);
  });

  it("THROWS on a Vercel deploy with no secret", () => {
    vi.stubEnv("SESSION_SECRET", "");
    vi.stubEnv("VERCEL", "1");
    expect(() => resolveSessionSecret()).toThrow(/SESSION_SECRET is missing or shorter/);
  });

  it("THROWS on a Vercel deploy with a too-short secret (<32)", () => {
    vi.stubEnv("SESSION_SECRET", "tooshort");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(() => resolveSessionSecret()).toThrow();
  });

  it("returns a valid secret on a Vercel deploy", () => {
    vi.stubEnv("SESSION_SECRET", VALID);
    vi.stubEnv("VERCEL", "1");
    expect(resolveSessionSecret()).toBe(VALID);
  });

  it("returns the secret in local dev when one is set", () => {
    vi.stubEnv("SESSION_SECRET", VALID);
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");
    expect(resolveSessionSecret()).toBe(VALID);
  });
});

describe("sessionOptions", () => {
  it("builds fleet-standard options bound to the given cookie name", () => {
    vi.stubEnv("SESSION_SECRET", VALID);
    vi.stubEnv("VERCEL", "1");
    const opts = sessionOptions("fcr-hr-session");
    expect(opts.password).toBe(VALID);
    expect(opts.cookieName).toBe("fcr-hr-session");
    expect(opts.cookieOptions).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
  });

  it("propagates the fail-closed throw (does not sign with the fallback on a deploy)", () => {
    vi.stubEnv("SESSION_SECRET", "");
    vi.stubEnv("VERCEL", "1");
    expect(() => sessionOptions("fcr-hr-session")).toThrow();
  });
});

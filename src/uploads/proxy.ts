// Shared blob-streaming tail for the apps' auth-gated record proxies (unit_file + unit_photo).
// Each app's proxy route resolves + authorizes the row itself, then hands the stored blob url here.
// Extracted to @fcr/core (fcr-trailers #48) so the security-sensitive stream logic lives in ONE place
// (the dispatch file and photo proxies had drifted — nosniff was on one, not the other).
//
// NOTE: the fcr1 Blob store is a PUBLIC store — private access is not available on it (proven by a
// write→read smoke test: `Cannot use private access on a public store`). So files/photos are stored
// access:"public" and the bytes live at a random-suffix capability URL. The auth gate is still
// meaningful because the app NEVER surfaces that raw url — it only ever links this proxy — but anyone
// who obtains the url (it could leak via logs/referrer) can fetch the bytes. Documented residual; a
// real private store is the follow-up if that residual isn't acceptable.
//
// @fcr/core stays dependency-free: @vercel/blob is NOT imported. The app injects `resolveDownloadUrl`
// (its head()-based resolver) to get a stable download url; omit it and the stored url is fetched
// directly (a public blob is fetchable as-is).
import { sanitizeFilename } from "./seam.js";

export type DownloadUrlResolver = (storedUrl: string) => Promise<string>;

export async function streamBlob(
  storedUrl: string,
  opts: {
    contentType: string | null;
    fallbackType: string;
    filename?: string;
    resolveDownloadUrl?: DownloadUrlResolver;
  },
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": opts.contentType ?? opts.fallbackType,
    // User-uploaded bytes served same-origin — stop the browser MIME-sniffing a declared image/pdf
    // whose bytes are HTML into a same-origin script.
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=300",
  };
  if (opts.filename) {
    headers["Content-Disposition"] = `inline; filename="${sanitizeFilename(opts.filename)}"`;
  }

  // A resolved (head()) url is stable; proxying keeps it inside our auth scope. Fall back to the
  // stored url on any resolver failure (a public blob is still fetchable directly).
  let blobUrl = storedUrl;
  if (opts.resolveDownloadUrl) {
    try {
      blobUrl = (await opts.resolveDownloadUrl(storedUrl)) || storedUrl;
    } catch {
      // fall back to the stored url
    }
  }
  // A network-level failure (DNS, reset, abort, malformed url) must degrade to the same 502 as an
  // HTTP-level one — not escape as an unhandled 500. Wrap the fetch itself, mirroring resolveDownloadUrl.
  let upstream: Response;
  try {
    upstream = await fetch(blobUrl);
  } catch {
    return new Response(JSON.stringify({ error: "fetch failed" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!upstream.ok || !upstream.body) {
    return new Response(JSON.stringify({ error: "fetch failed" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(upstream.body, { status: 200, headers });
}

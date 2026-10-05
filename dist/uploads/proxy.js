export async function streamBlob(storedUrl, opts) {
    const headers = {
        "Content-Type": opts.contentType ?? opts.fallbackType,
        // User-uploaded bytes served same-origin — stop the browser MIME-sniffing a declared image/pdf
        // whose bytes are HTML into a same-origin script.
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=300",
    };
    if (opts.filename) {
        const safe = opts.filename.replace(/[^\w.\-]/g, "_");
        headers["Content-Disposition"] = `inline; filename="${safe}"`;
    }
    // A resolved (head()) url is stable; proxying keeps it inside our auth scope. Fall back to the
    // stored url on any resolver failure (a public blob is still fetchable directly).
    let blobUrl = storedUrl;
    if (opts.resolveDownloadUrl) {
        try {
            blobUrl = (await opts.resolveDownloadUrl(storedUrl)) || storedUrl;
        }
        catch {
            // fall back to the stored url
        }
    }
    const upstream = await fetch(blobUrl);
    if (!upstream.ok || !upstream.body) {
        return new Response(JSON.stringify({ error: "fetch failed" }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
        });
    }
    return new Response(upstream.body, { status: 200, headers });
}

export function rowsOf(raw) {
    return (Array.isArray(raw) ? raw : raw.rows);
}
// The one allowed-character policy for a user-supplied unit-file name, shared by the write core
// (storing the clean filename) and the proxy (the Content-Disposition filename) so the policy can't
// drift between them — the whole reason this subsystem is one module (the proxy header records how
// `nosniff` drifted between two app routes before). Callers add their own length cap / fallback.
export function sanitizeFilename(name) {
    return name.replace(/[^\w.\-]/g, "_");
}

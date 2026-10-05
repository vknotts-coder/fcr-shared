export function rowsOf(raw) {
    return (Array.isArray(raw) ? raw : raw.rows);
}

// @fcr/core/photo-estimates — shared domain for the Photo Estimates module (epic
// fcr-estimating#94). A Sales→Estimating request to write an estimate from photos (or a
// comparative/competitor estimate), tracked on its own board to completion, and — on customer
// accept — converted into a real truck in the normal workflow.
//
// Lives in @fcr/core (not app-local like donor) because TWO apps share the row + status machine:
// fcr-sales submits, fcr-estimating works/completes/converts. Keeping the single source of the
// status set + transitions here prevents the two apps from drifting. React-free and
// DB-driver-free: the consuming app injects a Queryable (same contract as intake/events/rbac).
//
// The fcr_core.photo_estimate table is APP-OWNED and NEVER a Salesforce sync target. The only SF
// exposure is downstream and deliberate: accept→convert (S5) calls @fcr/core/intake createUnits,
// which makes a normal, syncing truck — the photo_estimate row itself never syncs.
export const PHOTO_ESTIMATE_STATUSES = [
    "unassigned",
    "in_progress",
    "completed",
    "accepted",
    "declined",
];
export const PHOTO_ESTIMATE_STATUS_LABEL = {
    unassigned: "Unassigned",
    in_progress: "In Progress",
    completed: "Completed",
    accepted: "Accepted",
    declined: "Declined",
};
/** On the board (active work). accepted/declined leave the board but stay in the list + counter. */
export const PHOTO_ESTIMATE_BOARD_STATUSES = [
    "unassigned",
    "in_progress",
    "completed",
];
export const PHOTO_ESTIMATE_TERMINAL_STATUSES = ["accepted", "declined"];
export function isTerminalStatus(s) {
    return s === "accepted" || s === "declined";
}

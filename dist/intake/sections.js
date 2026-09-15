// SF page-layout sections for the unit intake/edit form. Self-contained in the package (a
// copy of the fleet's read-registry section model) so @fcr/core/intake carries no app import.
// A consuming app renders TRAILER/TRUCK form fields grouped by these, in SECTION_ORDER.
export const SECTION_TITLES = {
    information: "Information",
    incoming_transport: "Incoming Transportation",
    estimate: "Estimate Information",
    parts: "Parts Information",
    repair: "Repair Information",
    outgoing_transport: "Outgoing Transportation",
    invoice: "Invoice Information",
    rework: "Rework",
    system: "System Information",
};
/** Render order — the Salesforce page-layout order top to bottom. */
export const SECTION_ORDER = [
    "information",
    "incoming_transport",
    "estimate",
    "parts",
    "repair",
    "outgoing_transport",
    "invoice",
    "rework",
    "system",
];

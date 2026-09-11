// Reportable-object + list-view CATALOG (#107 Slice 1). The fcr_core-coupled schema half of the FCR list
// views, shared so apps don't copy-paste-and-drift it. The app injects the object gate (`capability`) and
// detail-page routing (`link`) into the object factories; the list-view definitions are pure data.
//
// Barrel re-export. Prefer the per-object subpaths (`@fcr/core/catalog/truck`, `.../trailer`,
// `.../listviews`) when an app needs only one — e.g. a trucks-only app imports just `@fcr/core/catalog/truck`.

export { truckObject, truckFields, type TruckObjectOptions } from "./truck.js";
export { trailerObject, trailerFields, type TrailerObjectOptions } from "./trailer.js";
export * from "./listviews.js";

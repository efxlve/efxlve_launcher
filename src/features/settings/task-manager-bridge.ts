/**
 * Tiny bridge for the two Task Manager calls the global input listeners make.
 *
 * Importing the panel directly there put its chunk back into the boot bundle.
 * The detail drawer and the search field only exist after the panel rendered,
 * so the dynamic import normally resolves from the already loaded chunk.
 */

export function applyTaskFilter(query: string): void {
  void import("./task-manager")
    .then((module) => module.applyTaskFilter(query))
    .catch(() => {});
}

export function closeTaskDetail(): void {
  // Escape is pressed all over the launcher; only load the panel when its
  // detail drawer is actually on screen.
  if (!document.getElementById("tm-detail-root")) return;
  void import("./task-manager")
    .then((module) => module.closeTaskDetail())
    .catch(() => {});
}

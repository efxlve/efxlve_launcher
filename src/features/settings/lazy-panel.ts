/**
 * Lazy loader for the heavy Settings panels.
 *
 * The Task Manager, Achievements and Theme panels are self-contained but large.
 * Keeping them out of the Settings page's initial chunk avoids parsing their
 * code on every launcher start; each one loads the first time its section is
 * opened, and the page repaints when the chunk lands.
 */

import { render } from "../../core/render";

interface LazyPanel<T> {
  /** The loaded module, or null while the chunk is still in flight. */
  get: () => T | null;
  /** Starts the import unless it already ran or is running. */
  ensure: () => void;
}

export function createLazyPanel<T>(importer: () => Promise<T>): LazyPanel<T> {
  let module: T | null = null;
  let pending: Promise<T> | null = null;
  return {
    get: () => module,
    ensure: () => {
      if (module || pending) return;
      const job = importer().then((loaded) => {
        module = loaded;
        render();
        return loaded;
      });
      pending = job;
      void job.catch(() => {
        // A failed chunk must not poison the next attempt.
        if (pending === job) pending = null;
      });
    },
  };
}

/** The placeholder shown while a panel chunk loads. */
export function panelLoadingState(): string {
  return `<div class="empty-state"><span class="spinner"></span></div>`;
}

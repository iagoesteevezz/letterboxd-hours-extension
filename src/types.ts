// Shared type definitions used by both the content script and the background worker.

/** What we persist per user in chrome.storage.local under `profile:<username>`. */
export interface ProfileRecord {
  username: string;
  /** "Films" count read from the profile DOM at the time of the last full calc. */
  totalFilms: number;
  /** Sum of every known runtime (in minutes) for this user's watched films. */
  totalMinutes: number;
  /** Slugs counted in totalMinutes (lets us diff against a fresh scrape later). */
  slugs: string[];
  /**
   * True only when the calculation finished fully (not interrupted by a page
   * reload / navigation). An incomplete record holds partial progress and must
   * never be trusted as final — it triggers a "finish the calculation" prompt.
   */
  complete: boolean;
  /** Epoch ms of the last successful calculation. */
  updatedAt: number;
}

/** Messages the content script sends to the background worker over a Port. */
export type RequestMessage = {
  type: "CALCULATE";
  username: string;
  /** DOM "Films" count, so the worker can record the authoritative total. */
  domFilms: number;
  /** force = ignore the cached profile total and recompute the slug list. */
  force: boolean;
};

/** Messages the background worker pushes back to the content script over the Port. */
export type ResponseMessage =
  | { type: "PROGRESS"; phase: "list" | "runtimes"; done: number; total: number }
  | { type: "RESULT"; record: ProfileRecord }
  | { type: "ERROR"; message: string };

export const PROFILE_KEY = (username: string) => `profile:${username.toLowerCase()}`;
/** Global slug -> runtime(min) cache, shared across all profiles to avoid refetching films. */
export const RUNTIME_CACHE_KEY = "runtimeCache";
export const PORT_NAME = "letterboxd-hours";

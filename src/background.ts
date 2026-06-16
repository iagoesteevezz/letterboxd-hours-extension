// --------------------------------------------------------------------------
// Background service worker = the scraping engine.
//
// Why here and not the content script?
//   * It survives page navigation (a long scrape won't die if the user clicks).
//   * It owns chrome.storage and the global runtime cache.
//   * host_permissions let it fetch letterboxd.com pages with the user's
//     cookies (credentials:"include"), so private/friends-only diary entries
//     are counted just like the user sees them.
//
// Caching has two layers:
//   1. Per-profile record: { username, totalFilms, totalMinutes, slugs }.
//   2. Global slug -> runtime(min) cache, shared across profiles.
//
// Three execution paths, cheapest first:
//   * FAST   - cached film count == DOM count  -> return instantly, no network.
//   * DELTA  - DOM has a few more films         -> scan newest-first, fetch ONLY
//              the new films, add their minutes to the stored total. Never
//              re-processes films already counted.
//   * FULL   - no cache / count shrank / forced -> walk every list page.
// --------------------------------------------------------------------------
import {
  PORT_NAME,
  ProfileRecord,
  RequestMessage,
  ResponseMessage,
} from "./types";
import { getProfile, setProfile, getRuntimeCache, setRuntimeCache } from "./storage";
import { runPool } from "./rateLimiter";
import { extractFilmSlugs, extractLastPage, extractRuntime } from "./parser";

// ---- Tuning knobs for politeness --------------------------------------------
// A reasonable balance between speed and being a good citizen. If you ever see
// HTTP 429 (Too Many Requests) in the logs, dial these back down.
const CONCURRENCY = 6; // simultaneous in-flight requests
const DELAY_MS = 250; // gap between starting requests
const LIST_DELAY_MS = 400; // list pages are heavier; space them out a bit more
const MAX_PAGES_SAFETY = 200; // hard stop so a markup change can't loop forever

const BASE = "https://letterboxd.com";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetch a Letterboxd page as text, sending the user's cookies. */
async function fetchPage(url: string, signal?: AbortSignal): Promise<string> {
  // No custom headers: anything that looks like an AJAX request can make
  // Letterboxd return a stripped fragment without the runtime footer.
  const res = await fetch(url, { credentials: "include", signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/**
 * Resolves runtimes (minutes) for a set of slugs, fetching ONLY the ones whose
 * runtime isn't already in the global cache. Returns the (possibly updated)
 * cache so the caller can sum from it. This is the film-page-level delta.
 */
async function resolveRuntimes(
  slugs: string[],
  post: (m: ResponseMessage) => void,
  signal: AbortSignal
): Promise<Record<string, number>> {
  const cache = await getRuntimeCache();
  const missing = slugs.filter((s) => cache[s] === undefined);

  post({ type: "PROGRESS", phase: "runtimes", done: 0, total: missing.length });
  if (missing.length === 0) return cache;

  await runPool(
    missing,
    async (slug) => {
      const html = await fetchPage(`${BASE}/film/${slug}/`, signal);
      cache[slug] = extractRuntime(html); // 0 if unknown; cached either way
    },
    {
      concurrency: CONCURRENCY,
      delayMs: DELAY_MS,
      signal,
      onProgress: (done, total) =>
        post({ type: "PROGRESS", phase: "runtimes", done, total }),
    }
  );

  await setRuntimeCache(cache); // persist newly learned runtimes
  return cache;
}

const sumMinutes = (slugs: string[], cache: Record<string, number>): number =>
  slugs.reduce((acc, s) => acc + (cache[s] || 0), 0);

// ---- FULL: walk every list page --------------------------------------------
async function calcFull(
  username: string,
  domFilms: number,
  post: (m: ResponseMessage) => void,
  signal: AbortSignal
): Promise<ProfileRecord> {
  const firstHtml = await fetchPage(`${BASE}/${username}/films/page/1/`, signal);
  const lastPage = Math.min(extractLastPage(firstHtml), MAX_PAGES_SAFETY);

  const slugs = extractFilmSlugs(firstHtml);
  post({ type: "PROGRESS", phase: "list", done: 1, total: lastPage });

  for (let page = 2; page <= lastPage; page++) {
    if (signal.aborted) break;
    await sleep(LIST_DELAY_MS);
    const html = await fetchPage(`${BASE}/${username}/films/page/${page}/`, signal);
    const pageSlugs = extractFilmSlugs(html);
    post({ type: "PROGRESS", phase: "list", done: page, total: lastPage });
    if (pageSlugs.length === 0) break;
    for (const s of pageSlugs) if (!slugs.includes(s)) slugs.push(s);
  }

  const cache = await resolveRuntimes(slugs, post, signal);
  const record: ProfileRecord = {
    username,
    totalFilms: domFilms || slugs.length,
    totalMinutes: sumMinutes(slugs, cache),
    slugs,
    updatedAt: Date.now(),
  };
  await setProfile(record);
  return record;
}

// ---- DELTA: only the newly added films -------------------------------------
// Scans the films list ordered by "When Added (newest first)" so brand-new
// films sit at the top. We collect slugs page by page until we hit one we
// already have stored — at that point everything below is already counted, so
// we stop. Then we fetch runtimes for ONLY the new slugs and add them to the
// stored total. Returns null if we can't safely anchor (caller falls back to FULL).
async function calcDelta(
  cached: ProfileRecord,
  domFilms: number,
  post: (m: ResponseMessage) => void,
  signal: AbortSignal
): Promise<ProfileRecord | null> {
  const username = cached.username;
  const known = new Set(cached.slugs);
  const expectedNew = Math.max(0, domFilms - cached.totalFilms);

  const newSlugs: string[] = [];
  let anchored = false; // did we reach previously-known films?

  for (let page = 1; page <= MAX_PAGES_SAFETY; page++) {
    if (signal.aborted) break;
    if (page > 1) await sleep(LIST_DELAY_MS);

    const html = await fetchPage(
      `${BASE}/${username}/films/by/date/page/${page}/`,
      signal
    );
    const pageSlugs = extractFilmSlugs(html);
    if (pageSlugs.length === 0) break;

    for (const s of pageSlugs) {
      if (known.has(s)) {
        anchored = true; // reached the old films -> nothing new below
        break;
      }
      newSlugs.push(s);
    }
    post({ type: "PROGRESS", phase: "list", done: page, total: page });

    if (anchored) break;
    // Safety valve: if we've scanned well past the expected count without
    // finding a known film, the cache is probably out of sync -> bail to FULL.
    if (newSlugs.length > expectedNew + 50) break;
  }

  if (!anchored) return null; // couldn't anchor against the cache; do a FULL pass

  // Resolve runtimes for ONLY the new films (further deduped by the global cache).
  const cache = await resolveRuntimes(newSlugs, post, signal);
  const addedMinutes = sumMinutes(newSlugs, cache);

  const record: ProfileRecord = {
    username,
    totalFilms: domFilms, // authoritative count from the DOM
    totalMinutes: cached.totalMinutes + addedMinutes, // add, never recompute old
    slugs: [...newSlugs, ...cached.slugs], // newest first, no dupes (all unknown)
    updatedAt: Date.now(),
  };
  await setProfile(record);
  return record;
}

// ---- Orchestrator -----------------------------------------------------------
async function calculate(
  req: RequestMessage,
  post: (m: ResponseMessage) => void,
  signal: AbortSignal
): Promise<void> {
  const { username, domFilms, force } = req;
  const cached = await getProfile(username);

  if (!force && cached) {
    // FAST path: counts already match -> echo cache, zero network.
    if (cached.totalFilms === domFilms) {
      post({ type: "RESULT", record: cached });
      return;
    }
    // DELTA path: a few new films were added.
    if (domFilms > cached.totalFilms && cached.slugs.length > 0) {
      const delta = await calcDelta(cached, domFilms, post, signal);
      if (delta) {
        post({ type: "RESULT", record: delta });
        return;
      }
      // delta couldn't anchor -> fall through to FULL
    }
  }

  // FULL path: no usable cache, count shrank, forced, or delta bailed.
  const record = await calcFull(username, domFilms, post, signal);
  post({ type: "RESULT", record });
}

// ---- Port wiring ------------------------------------------------------------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;

  // One abort controller per connection so disconnect cancels in-flight fetches.
  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());

  const post = (m: ResponseMessage) => {
    try {
      port.postMessage(m);
    } catch {
      /* port already closed; ignore */
    }
  };

  port.onMessage.addListener((msg: RequestMessage) => {
    if (msg?.type !== "CALCULATE") return;
    calculate(msg, post, controller.signal).catch((err) => {
      post({ type: "ERROR", message: err?.message ?? String(err) });
    });
  });
});

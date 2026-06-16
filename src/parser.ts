// --------------------------------------------------------------------------
// HTML parsing helpers.
//
// Runs inside the MV3 service worker, where DOMParser is NOT available, so we
// extract the few values we need with focused regexes against the raw HTML.
// Patterns verified against live Letterboxd markup (June 2026).
// --------------------------------------------------------------------------

/**
 * Extracts unique film slugs from a "/<user>/films[/by/date]/page/N/" list page.
 *
 * Letterboxd's poster markup varies (lazy-loading, redesigns), so we try a few
 * patterns in order and use whichever yields the most slugs. `data-film-slug`
 * is the usual one; the others are resilient fallbacks. Order is preserved.
 */
export function extractFilmSlugs(html: string): string[] {
  const strategies: RegExp[] = [
    /data-film-slug="([^"]+)"/g,
    /data-item-slug="([^"]+)"/g,
    /data-target-link="\/film\/([^/"]+)\/?"/g,
    /data-film-link="\/film\/([^/"]+)\/?"/g,
    /href="\/film\/([^/"?#]+)\/?"/g,
  ];

  let best: string[] = [];
  for (const re of strategies) {
    const seen = new Set<string>();
    const found: string[] = [];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        found.push(m[1]);
      }
    }
    if (found.length > best.length) best = found;
  }
  return best;
}

/**
 * Reads the highest "films/page/N/" number from the pagination block so we know
 * how many list pages exist. Returns 1 when there is no pagination.
 */
export function extractLastPage(html: string): number {
  const re = /\/films\/(?:by\/[a-z-]+\/)?page\/(\d+)\//g;
  let max = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max;
}

/**
 * Extracts a film's runtime (in minutes) from its "/film/<slug>/" page.
 * Tries the footer paragraph first (most reliable), then any "<n> mins", then
 * an inline runtime number. Returns 0 when no runtime is present so the caller
 * can simply skip it.
 */
export function extractRuntime(html: string): number {
  const footer = html.match(
    /<p[^>]*class="[^"]*text-footer[^"]*"[^>]*>[\s\S]*?(\d[\d,]*)\s*(?:&nbsp;|&#160;|\s)?mins/i
  );
  const loose = footer ? null : html.match(/(\d[\d,]*)\s*(?:&nbsp;|&#160;|\s)?mins/i);
  const jsonish = footer || loose ? null : html.match(/"?run\s*[tT]ime"?\s*[:=]\s*"?(\d{1,4})/);

  const raw = footer?.[1] ?? loose?.[1] ?? jsonish?.[1];
  return raw ? parseInt(raw.replace(/,/g, ""), 10) || 0 : 0;
}

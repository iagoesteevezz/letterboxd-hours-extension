// --------------------------------------------------------------------------
// Content script = the UI layer.
//
// Responsibilities:
//   1. Decide whether we're on a profile page and find the stats block.
//   2. Read the native "Films" count straight from the DOM.
//   3. Clone the native stat element so our "HOURS" block inherits Letterboxd's
//      exact classes (typography, colors, spacing) and sits to the LEFT of FILMS.
//   4. Compare the DOM film count with our cache and render the right state:
//      fresh -> show instantly | stale/none -> show a discreet refresh control.
//   5. Drive the background worker over a Port and reflect progress/loading.
//
// All scraping/network/rate-limiting lives in the background worker; this file
// only touches the DOM and messaging.
// --------------------------------------------------------------------------
import {
  PORT_NAME,
  ProfileRecord,
  RequestMessage,
  ResponseMessage,
} from "./types";

const MARKER = "lh-hours-stat"; // dedupe class on our injected node

// Letterboxd top-level paths that are NOT usernames. If the first path segment
// is one of these, we're not on a profile and must not inject.
const RESERVED = new Set([
  "films", "film", "lists", "list", "members", "journal", "settings", "pro",
  "search", "activity", "actor", "director", "writer", "studio", "country",
  "year", "genre", "about", "contact", "help", "welcome", "sign-in", "create-account",
  "people", "tag", "reviews", "crew", "api-beta", "legal", "gift-guide",
  "year-in-review", "video-store", "apps", "news", "s",
]);

/** Returns the username if the current URL is a profile-style page, else null. */
function getProfileUsername(): string | null {
  const seg = location.pathname.split("/").filter(Boolean);
  if (seg.length === 0) return null;
  const first = seg[0];
  if (RESERVED.has(first.toLowerCase())) return null;
  // Profiles are "/<user>/" and tabs like "/<user>/films/", "/<user>/diary/".
  // We only inject on pages that actually render the profile stats block, so a
  // permissive check here is fine.
  return first;
}

/** Find the stats container and the individual statistic nodes. */
function findStats(): { container: HTMLElement; films: HTMLElement } | null {
  // The header stats live in a container; each metric is a `.profile-statistic`.
  const stats = Array.from(
    document.querySelectorAll<HTMLElement>(".profile-statistic")
  );
  if (stats.length === 0) return null;

  // Identify the "Films" metric by its definition label.
  const films = stats.find((el) => {
    const def = el.querySelector(".definition")?.textContent?.trim().toLowerCase();
    return def === "films";
  });
  if (!films) return null;

  const container = films.parentElement as HTMLElement | null;
  if (!container) return null;
  return { container, films };
}

/** Parse an integer out of a stat's `.value` (handles "1,234" style numbers). */
function readValue(stat: HTMLElement): number {
  const txt = stat.querySelector(".value")?.textContent ?? "";
  return parseInt(txt.replace(/[^\d]/g, ""), 10) || 0;
}

// ---- One-time CSS for our small controls (spinner + buttons) ----------------
function injectStyles(): void {
  if (document.getElementById("lh-hours-styles")) return;
  const style = document.createElement("style");
  style.id = "lh-hours-styles";
  style.textContent = `
    .${MARKER} .lh-ctl {
      display: inline-flex; align-items: center; gap: .35em;
      margin-top: .25em; font-size: 11px; line-height: 1;
      color: #9ab; cursor: pointer; user-select: none;
      background: none; border: 0; padding: 0;
    }
    .${MARKER} .lh-ctl:hover { color: #00c030; }
    .${MARKER} .lh-spin {
      width: 11px; height: 11px; border: 2px solid #456;
      border-top-color: #00c030; border-radius: 50%;
      display: inline-block; animation: lh-rot .7s linear infinite;
    }
    @keyframes lh-rot { to { transform: rotate(360deg); } }
    .${MARKER} .lh-note { font-size: 11px; color: #789; margin-top: .25em; }
  `;
  document.head.appendChild(style);
}

// ---- The injected widget ----------------------------------------------------
class HoursWidget {
  readonly el: HTMLElement; // the cloned stat node
  private valueEl: HTMLElement;
  private ctlHost: HTMLElement; // holds button / progress text

  constructor(filmsStat: HTMLElement) {
    // Clone the native Films stat so we inherit EXACT classes + styling.
    this.el = filmsStat.cloneNode(true) as HTMLElement;
    this.el.classList.add(MARKER);
    // If the original is a link, make our clone inert (don't navigate).
    if (this.el.tagName === "A") this.el.removeAttribute("href");

    this.el.querySelector(".definition")!.textContent = "Hours";
    this.valueEl = this.el.querySelector(".value") as HTMLElement;
    this.valueEl.textContent = "–";

    // A host node for our small control row, appended inside the stat.
    this.ctlHost = document.createElement("div");
    this.el.appendChild(this.ctlHost);
  }

  setHours(minutes: number): void {
    this.valueEl.textContent = String(Math.round(minutes / 60));
  }

  /** A discreet refresh/calc affordance with a label. */
  showButton(label: string, onClick: () => void): void {
    this.ctlHost.innerHTML = "";
    const btn = document.createElement("button");
    btn.className = "lh-ctl";
    btn.type = "button";
    btn.innerHTML = `<span aria-hidden="true">↻</span><span>${label}</span>`;
    btn.addEventListener("click", onClick);
    this.ctlHost.appendChild(btn);
  }

  /** Spinner + progress text while the worker scrapes. */
  showLoading(text: string): void {
    this.ctlHost.innerHTML = `<span class="lh-ctl"><span class="lh-spin"></span><span>${text}</span></span>`;
  }

  clearControl(): void {
    this.ctlHost.innerHTML = "";
  }

  showError(onRetry: () => void): void {
    this.ctlHost.innerHTML = "";
    const wrap = document.createElement("button");
    wrap.className = "lh-ctl";
    wrap.type = "button";
    wrap.innerHTML = `<span aria-hidden="true">⚠</span><span>Reintentar</span>`;
    wrap.addEventListener("click", onRetry);
    this.ctlHost.appendChild(wrap);
  }
}

// ---- Talking to the background worker --------------------------------------
function calculate(
  req: RequestMessage,
  handlers: {
    onProgress: (m: Extract<ResponseMessage, { type: "PROGRESS" }>) => void;
    onResult: (r: ProfileRecord) => void;
    onError: (msg: string) => void;
  }
): void {
  const port = chrome.runtime.connect({ name: PORT_NAME });
  port.onMessage.addListener((msg: ResponseMessage) => {
    if (msg.type === "PROGRESS") handlers.onProgress(msg);
    else if (msg.type === "RESULT") {
      handlers.onResult(msg.record);
      port.disconnect();
    } else if (msg.type === "ERROR") {
      handlers.onError(msg.message);
      port.disconnect();
    }
  });
  port.postMessage(req);
}

async function getCachedProfile(username: string): Promise<ProfileRecord | null> {
  const key = `profile:${username.toLowerCase()}`;
  const out = await chrome.storage.local.get(key);
  return (out[key] as ProfileRecord) ?? null;
}

// ---- Wiring it all together -------------------------------------------------
async function init(): Promise<void> {
  const username = getProfileUsername();
  if (!username) return;

  const stats = findStats();
  if (!stats) return;
  if (stats.container.querySelector(`.${MARKER}`)) return; // already injected

  injectStyles();

  const domFilms = readValue(stats.films);
  const widget = new HoursWidget(stats.films);
  // Insert to the LEFT of the Films stat.
  stats.container.insertBefore(widget.el, stats.films);

  const cached = await getCachedProfile(username);

  // Wraps the calculate() call with all the UI state transitions.
  const run = (force: boolean) => {
    widget.showLoading("Calculando…");
    calculate(
      { type: "CALCULATE", username, domFilms, force },
      {
        onProgress: (p) => {
          const label =
            p.phase === "list"
              ? `Listando ${p.done}/${p.total}`
              : `Duraciones ${p.done}/${p.total}`;
          widget.showLoading(label);
        },
        onResult: (record) => {
          widget.setHours(record.totalMinutes);
          // If somehow still behind the DOM, keep an update affordance (delta).
          if (record.totalFilms < domFilms) {
            widget.showButton("Actualizar horas", () => run(false));
          } else {
            widget.clearControl();
          }
        },
        onError: () => widget.showError(() => run(true)),
      }
    );
  };

  if (cached && cached.totalFilms === domFilms) {
    // Cache is fresh: show instantly, no network.
    widget.setHours(cached.totalMinutes);
    widget.clearControl();
  } else if (cached) {
    // Cache exists but profile grew: show old value + discreet "update" (delta).
    widget.setHours(cached.totalMinutes);
    widget.showButton("Actualizar horas", () => run(false));
  } else {
    // No cache yet: offer a one-click calculation (kept manual so we never
    // scrape without the user's intent).
    widget.showButton("Calcular horas", () => run(false));
  }
}

/**
 * The stats block is server-rendered, but we retry a few times in case the
 * header mounts slightly late. Bail out quietly once injected or after retries.
 */
function boot(retries = 10): void {
  if (getProfileUsername() && findStats()) {
    void init();
    return;
  }
  if (retries > 0) setTimeout(() => boot(retries - 1), 300);
}

boot();

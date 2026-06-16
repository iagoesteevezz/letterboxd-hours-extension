// --------------------------------------------------------------------------
// Tiny i18n helper for the injected UI strings.
//
// We detect the browser/extension UI language and pick a string table.
// English is the default; add more languages by extending STRINGS below.
// (The numbers and the native Letterboxd labels stay as-is; only OUR text
// is translated.)
// --------------------------------------------------------------------------

type Lang = "en" | "es";

interface Strings {
  hours: string; // the stat label, e.g. "Hours" (CSS upper-cases it)
  calc: string; // first-time calculate button
  update: string; // delta update button
  finish: string; // finish an interrupted calculation
  resume: string; // resume after an error / dropped connection
  calculating: string; // generic loading text
  listing: string; // progress phase: collecting the film list
  runtimes: string; // progress phase: fetching film runtimes
}

const STRINGS: Record<Lang, Strings> = {
  en: {
    hours: "Hours",
    calc: "Calculate hours",
    update: "Update hours",
    finish: "Finish calculation",
    resume: "Resume calculation",
    calculating: "Calculating…",
    listing: "Listing",
    runtimes: "Runtimes",
  },
  es: {
    hours: "Horas",
    calc: "Calcular horas",
    update: "Actualizar horas",
    finish: "Completar cálculo",
    resume: "Reanudar cálculo",
    calculating: "Calculando…",
    listing: "Listando",
    runtimes: "Duraciones",
  },
};

function detectLang(): Lang {
  // chrome.i18n.getUILanguage() = the browser UI language; fall back to the
  // page/navigator language. Match only the primary subtag ("es-419" -> "es").
  const raw = (
    chrome.i18n?.getUILanguage?.() ||
    navigator.language ||
    "en"
  ).toLowerCase();
  if (raw.startsWith("es")) return "es";
  return "en";
}

/** Localized strings for the current language (resolved once at load). */
export const L: Strings = STRINGS[detectLang()];

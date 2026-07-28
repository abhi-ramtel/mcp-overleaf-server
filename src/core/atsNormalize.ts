/**
 * ATS text normalization — convert Unicode that PDF text extractors and legacy
 * ATS parsers choke on into safe ASCII. Ported from career-ops' normalizeTextForATS,
 * adapted to operate on plain text (the LaTeX/renderer path, not HTML).
 *
 * Runs BEFORE LaTeX escaping so that, e.g., an em-dash becomes "-" rather than a
 * raw Unicode byte that pdfLaTeX would mis-handle.
 */

export interface NormalizeResult {
  text: string;
  replacements: Record<string, number>;
}

/** Normalize and report what changed (useful for logging/ATS reports). */
export function normalizeTextVerbose(input: string): NormalizeResult {
  const replacements: Record<string, number> = {};
  const bump = (key: string) => {
    replacements[key] = (replacements[key] ?? 0) + 1;
  };
  let t = input;
  t = t.replace(/—/g, () => (bump("em-dash"), "-"));
  t = t.replace(/–/g, () => (bump("en-dash"), "-"));
  t = t.replace(/[“”„‟]/g, () => (bump("smart-double-quote"), '"'));
  t = t.replace(/[‘’‚‛]/g, () => (bump("smart-single-quote"), "'"));
  t = t.replace(/…/g, () => (bump("ellipsis"), "..."));
  t = t.replace(/[​‌‍⁠﻿]/g, () => (bump("zero-width"), ""));
  t = t.replace(/ /g, () => (bump("nbsp"), " "));
  t = t.replace(/\s*→\s*/g, () => (bump("right-arrow"), " to "));
  t = t.replace(/\s*←\s*/g, () => (bump("left-arrow"), " from "));
  t = t.replace(/\s*[↑↓]\s*/g, () => (bump("vert-arrow"), " "));
  t = t.replace(/€/g, () => (bump("euro"), "EUR "));
  t = t.replace(/£/g, () => (bump("pound"), "GBP "));
  return { text: t, replacements };
}

/** Normalize plain text for ATS safety. */
export function normalizeText(input: string): string {
  return normalizeTextVerbose(input).text;
}

/**
 * Fast structural validation of a rendered .tex BEFORE compiling — cheaper and
 * clearer than a LaTeX error log. Ported/expanded from career-ops generate-latex.mjs.
 *
 * Hard errors block compilation (unresolved placeholders, missing document env).
 * Warnings are advisory (missing ATS pragma, low section count, CJK glyphs that
 * the pdfLaTeX template cannot render).
 */

// CJK ranges (Hiragana/Katakana/CJK ideographs/Hangul) — unrenderable by the
// Computer-Modern pdfLaTeX template; flag rather than emit a broken PDF.
const CJK_RE =
  /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ가-힯]/;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  counts: {
    sections: number;
    resumeItems: number;
    subheadings: number;
    projectHeadings: number;
  };
}

export function validateTex(content: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const sections = (content.match(/\\section\{/g) ?? []).length;
  // Count both the placeholder-template macros (\resumeItem/\resumeSubheading/
  // \resumeProjectHeading) and the native-document macros (\bul/\roleheading/
  // \projheading) so validation works for either style.
  const resumeItems = (content.match(/\\resumeItem\{|\\bul\{/g) ?? []).length;
  const subheadings = (content.match(/\\resumeSubheading(?![a-zA-Z])|\\roleheading/g) ?? []).length;
  const projectHeadings = (content.match(/\\resumeProjectHeading|\\projheading/g) ?? []).length;

  // --- Hard errors ---
  const unresolved = content.match(/\{\{[A-Z_]+\}\}/g);
  if (unresolved) {
    errors.push(`Unresolved placeholders: ${[...new Set(unresolved)].join(", ")}`);
  }
  if (!content.includes("\\begin{document}")) errors.push("Missing \\begin{document}");
  if (!content.includes("\\end{document}")) errors.push("Missing \\end{document}");
  if (sections < 2) errors.push(`Too few \\section{} blocks (found ${sections}, need at least 2)`);

  // --- Warnings ---
  if (sections < 4) {
    warnings.push(`Only ${sections} sections — a full CV usually has Education, Experience, Projects, Skills`);
  }
  if (resumeItems === 0) warnings.push("No \\resumeItem bullets found");
  if (subheadings === 0 && projectHeadings === 0) {
    warnings.push("No \\resumeSubheading or \\resumeProjectHeading entries found");
  }
  if (!content.includes("\\pdfgentounicode=1")) {
    warnings.push("Missing \\pdfgentounicode=1 — reduces ATS text extractability");
  }
  if (CJK_RE.test(content)) {
    warnings.push("CJK characters detected — the pdfLaTeX template cannot render them; use an HTML/xelatex path");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    counts: { sections, resumeItems, subheadings, projectHeadings },
  };
}

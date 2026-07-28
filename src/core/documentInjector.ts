/**
 * Native document injector — tailor a *finished* LaTeX résumé that has no
 * {{placeholders}}, by replacing only its section bodies while preserving the
 * preamble, header, custom macros, colors, fonts, and spacing verbatim.
 *
 * Targets documents that define the \roleheading / \projheading / \bul macro
 * family (as in the user's main.tex). Detection is via {@link isNativeDocument};
 * the placeholder renderer (latexRenderer.ts) handles {{token}} templates.
 */
import { escapeLatex } from "./latexRenderer.js";
import type { TailoredContent } from "./schema.js";

/** True if the doc is a finished résumé using the \roleheading/\bul macro family. */
export function isNativeDocument(tex: string): boolean {
  if (/\{\{[A-Z_]+\}\}/.test(tex)) return false; // it's a placeholder template
  return /\\roleheading|\\projheading|\\bul\b/.test(tex);
}

interface Section {
  key: string;
  titleLine: string;
  body: string;
}

const SECTION_ALIASES: Record<string, string> = {
  summary: "summary",
  "professional summary": "summary",
  experience: "experience",
  "work experience": "experience",
  projects: "projects",
  "personal projects": "projects",
  skills: "skills",
  "technical skills": "skills",
  education: "education",
};

function sectionKey(title: string): string {
  const norm = title.replace(/\\[a-zA-Z]+/g, "").replace(/[{}]/g, "").trim().toLowerCase();
  return SECTION_ALIASES[norm] ?? norm;
}

interface SplitDoc {
  head: string;
  sections: Section[];
  tail: string;
}

/** Split into head (preamble+header), \section blocks, and the \end{document} tail. */
function splitDocument(tex: string): SplitDoc | null {
  const matches = [...tex.matchAll(/\\section\{([^}]*)\}/g)];
  if (matches.length === 0) return null;

  const endDoc = tex.indexOf("\\end{document}");
  const contentEnd = endDoc >= 0 ? endDoc : tex.length;
  const tail = endDoc >= 0 ? tex.slice(endDoc) : "";
  const head = tex.slice(0, matches[0]!.index);

  const sections: Section[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const start = m.index!;
    const next = i + 1 < matches.length ? matches[i + 1]!.index! : contentEnd;
    const afterMacro = start + m[0].length;
    const nl = tex.indexOf("\n", afterMacro);
    const lineEnd = nl >= 0 && nl < next ? nl + 1 : afterMacro;
    sections.push({
      key: sectionKey(m[1] ?? ""),
      titleLine: tex.slice(start, lineEnd),
      body: tex.slice(lineEnd, next),
    });
  }
  return { head, sections, tail };
}

/** Match the document's en-dash date style ("A - B" → "A -- B"). */
function styleDates(dates: string): string {
  return escapeLatex(dates).replace(/\s-\s/g, " -- ");
}

function bulletBlock(bullets: { text: string }[]): string {
  const items = bullets.map((b) => `  \\bul{${escapeLatex(b.text)}}`).join("\n");
  return `\\bullist\n${items}\n\\stopbulls`;
}

function renderSummary(c: TailoredContent): string {
  return `\\vspace{-2pt}\n\\small{${escapeLatex(c.summary)}}\n\n\\vspace{-7pt}\n`;
}

function renderExperience(c: TailoredContent): string {
  const blocks = c.experience.map((e) => {
    const head = `\\roleheading{${escapeLatex(e.title)}}{${styleDates(e.dates)}}{${escapeLatex(e.organization)}}{${escapeLatex(e.location ?? "")}}`;
    return `${head}\n${bulletBlock(e.bullets)}`;
  });
  return `\\vspace{-2pt}\n${blocks.join("\n\\vspace{3pt}\n\n")}\n\\vspace{-7pt}\n`;
}

function renderProjects(c: TailoredContent): string {
  const blocks = c.projects.map((p) => {
    const heading = p.stack.trim()
      ? `\\projheading{\\textbf{${escapeLatex(p.name)}} $|$ \\emph{${escapeLatex(p.stack)}}}{${styleDates(p.dates)}}`
      : `\\projheading{\\textbf{${escapeLatex(p.name)}}}{${styleDates(p.dates)}}`;
    return `${heading}\n${bulletBlock(p.bullets)}`;
  });
  return `\\vspace{-2pt}\n${blocks.join("\n\\vspace{3pt}\n\n")}\n\\vspace{-7pt}\n`;
}

function renderSkills(c: TailoredContent): string {
  const lines = c.skills
    .map((cat) => `    \\textbf{${escapeLatex(cat.category)}:} ${escapeLatex(cat.items.join(", "))} \\\\`)
    .join("\n");
  return (
    `\\vspace{-2pt}\n` +
    `\\begin{itemize}[leftmargin=0pt, label={}, topsep=0pt, itemsep=1pt, parsep=0pt]\n` +
    `  \\small\\item\n${lines}\n\\end{itemize}\n\\vspace{-7pt}\n`
  );
}

export interface InjectOptions {
  /** Section keys to leave untouched (default: education — it rarely changes per role). */
  preserve?: string[];
}

/**
 * Inject tailored content into a finished document, replacing the bodies of the
 * Summary / Experience / Projects / Skills sections and preserving everything
 * else (preamble, header, section titles, Education, and the document tail).
 */
export function injectIntoDocument(tex: string, content: TailoredContent, opts: InjectOptions = {}): string {
  const split = splitDocument(tex);
  if (!split) throw new Error("Document has no \\section{} blocks to inject into.");
  const preserve = new Set(opts.preserve ?? ["education"]);

  const renderers: Record<string, (c: TailoredContent) => string> = {
    summary: renderSummary,
    experience: renderExperience,
    projects: renderProjects,
    skills: renderSkills,
  };

  const rebuilt = split.sections
    .map((s) => {
      const r = renderers[s.key];
      if (r && !preserve.has(s.key)) return s.titleLine + r(content);
      return s.titleLine + s.body;
    })
    .join("");

  return split.head + rebuilt + split.tail;
}

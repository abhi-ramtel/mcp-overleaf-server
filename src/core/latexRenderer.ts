/**
 * Render tailored content into a {{PLACEHOLDER}} LaTeX template.
 *
 * The renderer is the ONLY component that emits LaTeX. The host model returns
 * structured data; this module escapes it and injects it into the template's
 * macros, reproducing the exact conventions of the sb2nov-derived template:
 *
 *   Experience : \resumeSubheading{org}{dates}{title}{location}
 *   Education  : \resumeSubheading{institution}{location}{degree}{dates}
 *   Projects   : \resumeProjectHeading{\textbf{name} \emph{$|$ stack}}{dates}
 *   Skills     : \textbf{Category}{: items} \\
 *
 * Contact identity (name, email, links) always comes from the master CV and is
 * never tailored.
 */
import { normalizeText } from "./atsNormalize.js";
import type { MasterCv } from "./types.js";
import type {
  TailoredContent,
  TailoredEducation,
  TailoredExperience,
  TailoredProject,
  TailoredSkillCategory,
} from "./schema.js";

const LATEX_ESCAPES: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "&": "\\&",
  "%": "\\%",
  $: "\\$",
  "#": "\\#",
  _: "\\_",
  "{": "\\{",
  "}": "\\}",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
};

/** Escape a plain-text string for safe inclusion in LaTeX (single pass). */
export function escapeLatex(input: string): string {
  return normalizeText(input).replace(/[\\&%$#_{}~^]/g, (ch) => LATEX_ESCAPES[ch] ?? ch);
}

/** Escape a URL for use inside \href{...} (only %, #, & are structurally unsafe). */
function escapeUrl(url: string): string {
  return url.replace(/([%#&])/g, "\\$1");
}

/** Strip scheme + trailing slash for a clean href display, e.g. github.com/jane. */
function urlDisplay(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function findLink(cv: MasterCv, label: RegExp): { url: string; display: string } | undefined {
  const link = cv.contact.links.find((l) => label.test(l.label) || label.test(l.url));
  if (!link) return undefined;
  return { url: link.url, display: urlDisplay(link.url) };
}

export interface RenderOptions {
  /** Overrides the CONTACT_LINE under the name. Plain text; " | " becomes a divider. */
  headerLine?: string;
}

/** Build the small header line under the name (location/phone/portfolio). */
function buildHeaderLine(cv: MasterCv, opts: RenderOptions): string {
  if (opts.headerLine && opts.headerLine.trim()) {
    return escapeLatex(opts.headerLine.trim()).replace(/ \\\| /g, " $|$ ").replace(/\|/g, "$|$");
  }
  const parts: string[] = [];
  if (cv.contact.phone) parts.push(escapeLatex(cv.contact.phone));
  const portfolio = cv.contact.links.find((l) => /portfolio|website|site/i.test(l.label));
  if (portfolio) {
    parts.push(`\\href{${escapeUrl(portfolio.url)}}{${escapeLatex(urlDisplay(portfolio.url))}}`);
  }
  return parts.join(" $|$ ");
}

const INDENT = "            ";

function renderBullets(bullets: { text: string }[]): string {
  if (bullets.length === 0) return "";
  const items = bullets.map((b) => `${INDENT}\\resumeItem{${escapeLatex(b.text)}}`).join("\n");
  return `      \\resumeItemListStart\n${items}\n      \\resumeItemListEnd`;
}

function renderExperience(entries: TailoredExperience[]): string {
  return entries
    .map((e) => {
      const org = escapeLatex(e.organization);
      const dates = escapeLatex(e.dates);
      const title = escapeLatex(e.title);
      const loc = e.location ? escapeLatex(e.location) : "";
      return (
        `    \\resumeSubheading\n` +
        `      {${org}}{${dates}}\n` +
        `      {${title}}{${loc}}\n` +
        `${renderBullets(e.bullets)}`
      );
    })
    .join("\n\n");
}

function renderProjects(entries: TailoredProject[]): string {
  return entries
    .map((p) => {
      const name = escapeLatex(p.name);
      const dates = escapeLatex(p.dates);
      const heading = p.stack.trim()
        ? `{\\textbf{${name}} \\emph{$|$ ${escapeLatex(p.stack)}}}{${dates}}`
        : `{\\textbf{${name}}}{${dates}}`;
      return `    \\resumeProjectHeading\n      ${heading}\n${renderBullets(p.bullets)}`;
    })
    .join("\n\n");
}

function renderEducation(entries: TailoredEducation[]): string {
  return entries
    .map((ed) => {
      const inst = escapeLatex(ed.institution);
      const loc = ed.location ? escapeLatex(ed.location) : "";
      const degree = escapeLatex(ed.degree);
      const dates = escapeLatex(ed.dates);
      const extras: string[] = [];
      if (ed.coursework?.trim()) {
        extras.push(`${INDENT}\\resumeItem{\\textbf{Coursework:} ${escapeLatex(ed.coursework)}}`);
      }
      if (ed.honors?.trim()) {
        extras.push(`${INDENT}\\resumeItem{\\textbf{Honors \\& Activities:} ${escapeLatex(ed.honors)}}`);
      }
      const extrasBlock =
        extras.length > 0 ? `\n        \\resumeItemListStart\n${extras.join("\n")}\n        \\resumeItemListEnd` : "";
      return `    \\resumeSubheading\n      {${inst}}{${loc}}\n      {${degree}}{${dates}}${extrasBlock}`;
    })
    .join("\n\n");
}

function renderSkills(cats: TailoredSkillCategory[]): string {
  return cats
    .map((c) => `        \\textbf{${escapeLatex(c.category)}}{: ${escapeLatex(c.items.join(", "))}} \\\\`)
    .join("\n");
}

/**
 * Render the full .tex by replacing every {{PLACEHOLDER}} the template declares.
 * Unknown placeholders are left intact for the validator to flag.
 */
export function renderTemplate(
  template: string,
  cv: MasterCv,
  content: TailoredContent,
  opts: RenderOptions = {},
): string {
  const email = cv.contact.email ?? "";
  const linkedin = findLink(cv, /linkedin/i);
  const github = findLink(cv, /github/i);

  const values: Record<string, string> = {
    NAME: escapeLatex(cv.contact.name),
    CONTACT_LINE: buildHeaderLine(cv, opts),
    SUMMARY: escapeLatex(content.summary),
    EMAIL_URL: email,
    EMAIL_DISPLAY: escapeLatex(email),
    LINKEDIN_URL: linkedin ? escapeUrl(linkedin.url) : "",
    LINKEDIN_DISPLAY: escapeLatex(linkedin?.display ?? ""),
    GITHUB_URL: github ? escapeUrl(github.url) : "",
    GITHUB_DISPLAY: escapeLatex(github?.display ?? ""),
    EDUCATION: renderEducation(content.education),
    EXPERIENCE: renderExperience(content.experience),
    PROJECTS: renderProjects(content.projects),
    SKILLS: renderSkills(content.skills),
  };

  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) =>
    key in values ? (values[key] ?? "") : match,
  );
}

/**
 * Parse the master CV markdown (cv.md) into a structured {@link MasterCv}.
 *
 * The parser is deliberately tolerant — cv.md is hand-maintained, so it copes
 * with: bold headings whose title contains its own " - " (e.g. a TA course
 * code), bullets that wrap across several un-prefixed lines, a skills line that
 * omits the colon after the bold label, and markdown hard-break trailing spaces.
 */
import { readFile } from "node:fs/promises";
import type {
  Bullet,
  Contact,
  ContactLink,
  EducationEntry,
  ExperienceEntry,
  MasterCv,
  ProjectEntry,
  SkillCategory,
} from "./types.js";

const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
const BOLD_HEAD_RE = /^\*\*(.+?)\*\*\s*(.*)$/;
const BULLET_RE = /^[-*]\s+(.*)$/;

/** Read and parse cv.md from a path. */
export async function parseCvFile(path: string): Promise<MasterCv> {
  const raw = await readFile(path, "utf-8");
  return parseCv(raw);
}

/** Parse cv.md content already in memory. */
export function parseCv(markdown: string): MasterCv {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");

  // --- Header: name (# H1) + contact line ---
  let name = "";
  let contactLine = "";
  let cursor = 0;
  for (; cursor < lines.length; cursor++) {
    const line = (lines[cursor] ?? "").trim();
    if (!line) continue;
    const h1 = line.match(/^#\s+(.+)$/);
    if (h1) {
      name = (h1[1] ?? "").trim();
      cursor++;
      break;
    }
  }
  // First non-empty, non-heading line after the name is the contact line.
  for (; cursor < lines.length; cursor++) {
    const line = (lines[cursor] ?? "").trim();
    if (!line) continue;
    if (line.startsWith("#")) break;
    contactLine = line;
    cursor++;
    break;
  }
  const contact = parseContactLine(name, contactLine);

  // --- Split the rest into ## sections ---
  const sections = splitSections(lines.slice(cursor));

  const summary = (sections.get("summary") ?? [])
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .trim();

  const experience = parseEntries(sections.get("experience") ?? [], "EXP", "experience");
  const projects = parseEntries(sections.get("projects") ?? [], "PRJ", "projects");
  const education = parseEducation(sections.get("education") ?? []);
  const skills = parseSkills(sections.get("skills") ?? []);

  // --- Build provenance index + skill vocabulary ---
  const sourceIndex: Record<string, string> = {};
  if (summary) sourceIndex["SUM"] = summary;
  for (const e of experience as (ExperienceEntry | ProjectEntry)[]) {
    const heading = "title" in e ? `${e.title} — ${e.organization}` : "";
    if (heading) sourceIndex[e.id] = heading;
    for (const b of e.bullets) sourceIndex[b.id] = b.text;
  }
  for (const p of projects) {
    sourceIndex[p.id] = `${p.name} — ${p.stack}`;
    for (const b of p.bullets) sourceIndex[b.id] = b.text;
  }
  for (const ed of education) sourceIndex[ed.id] = `${ed.institution} — ${ed.degree}`;
  for (const s of skills) sourceIndex[s.id] = `${s.category}: ${s.items.join(", ")}`;

  const skillVocabulary = buildSkillVocabulary(skills);

  return { contact, summary, experience, projects, education, skills, sourceIndex, skillVocabulary };
}

function parseContactLine(name: string, line: string): Contact {
  const links: ContactLink[] = [];
  let m: RegExpExecArray | null;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(line)) !== null) {
    links.push({ label: (m[1] ?? "").trim(), url: (m[2] ?? "").trim() });
  }
  const rest = line.replace(LINK_RE, "").replace(/`/g, "");
  const parts = rest.split("|").map((s) => s.trim()).filter(Boolean);
  let phone: string | undefined;
  let email: string | undefined;
  for (const p of parts) {
    if (p.includes("@")) email = p;
    else if (/\d/.test(p) && /[+()\d][()\d\s.\-]{6,}/.test(p)) phone = p;
  }
  const contact: Contact = { name, links };
  if (phone) contact.phone = phone;
  if (email) contact.email = email;
  return contact;
}

/** Group lines under their `## Section` heading, keyed by a normalized alias. */
function splitSections(lines: string[]): Map<string, string[]> {
  const ALIASES = new Map<string, string>([
    ["summary", "summary"],
    ["professional summary", "summary"],
    ["experience", "experience"],
    ["work experience", "experience"],
    ["professional experience", "experience"],
    ["projects", "projects"],
    ["personal projects", "projects"],
    ["selected projects", "projects"],
    ["education", "education"],
    ["skills", "skills"],
    ["technical skills", "skills"],
    ["leadership", "leadership"],
  ]);
  const out = new Map<string, string[]>();
  let key: string | null = null;
  for (const rawLine of lines) {
    const heading = rawLine.match(/^##\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const norm = (heading[1] ?? "").trim().toLowerCase();
      key = ALIASES.get(norm) ?? norm;
      if (!out.has(key)) out.set(key, []);
      continue;
    }
    if (key) out.get(key)!.push(rawLine);
  }
  return out;
}

/**
 * Parse Experience / Projects entries. Both share the shape:
 *   **Heading** - remainder
 *   Date line
 *   - bullet
 *   - bullet (may wrap onto following un-prefixed lines)
 */
function parseEntries(
  body: string[],
  idPrefix: string,
  kind: "experience" | "projects",
): (ExperienceEntry & ProjectEntry)[] {
  const entries: (ExperienceEntry & ProjectEntry)[] = [];
  let i = 0;
  let entryNo = 0;

  while (i < body.length) {
    const line = (body[i] ?? "").trim();
    if (!line) {
      i++;
      continue;
    }
    const head = line.match(BOLD_HEAD_RE);
    if (!head) {
      i++;
      continue;
    }

    entryNo++;
    const id = `${idPrefix}${entryNo}`;
    const title = (head[1] ?? "").trim();
    const remainder = (head[2] ?? "").replace(/^\s*[-–—]\s*/, "").trim();
    i++;

    // Date line: next non-empty line that is not a bullet and not a new heading.
    let dates = "";
    while (i < body.length) {
      const l = (body[i] ?? "").trim();
      if (!l) {
        i++;
        continue;
      }
      if (BULLET_RE.test(l) || BOLD_HEAD_RE.test(l)) break;
      dates = l;
      i++;
      break;
    }

    // Bullets — collect, joining wrapped continuation lines.
    const bullets: Bullet[] = [];
    while (i < body.length) {
      const rawl = body[i] ?? "";
      const l = rawl.trim();
      if (!l) {
        i++;
        continue;
      }
      if (BOLD_HEAD_RE.test(l)) break; // next entry
      const bm = l.match(BULLET_RE);
      if (bm) {
        bullets.push({ id: `${id}.${bullets.length + 1}`, text: (bm[1] ?? "").trim() });
        i++;
      } else if (bullets.length > 0) {
        // Continuation of the previous bullet (wrapped line).
        const last = bullets[bullets.length - 1]!;
        last.text = `${last.text} ${l}`.replace(/\s+/g, " ").trim();
        i++;
      } else {
        i++; // stray line before any bullet
      }
    }

    const entry = { id, dates, bullets } as ExperienceEntry & ProjectEntry;
    if (kind === "experience") {
      const { organization, location } = splitOrgLocation(remainder);
      entry.title = title;
      entry.organization = organization;
      if (location) entry.location = location;
    } else {
      // A project heading may be a markdown link: **[Name](https://…)**
      const { text, url } = splitMarkdownLink(title);
      entry.name = text;
      if (url) entry.url = url;
      entry.stack = remainder;
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * `[Name](https://…)` → { text: "Name", url: "https://…" }.
 * Plain text passes through unchanged with no url.
 */
function splitMarkdownLink(input: string): { text: string; url?: string } {
  const m = input.trim().match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (!m) return { text: input.trim() };
  return { text: (m[1] ?? "").trim(), url: (m[2] ?? "").trim() };
}

/** "Company, City, ST" → { organization: "Company", location: "City, ST" }. */
function splitOrgLocation(text: string): { organization: string; location?: string } {
  const idx = text.indexOf(",");
  if (idx === -1) return { organization: text.trim() };
  return {
    organization: text.slice(0, idx).trim(),
    location: text.slice(idx + 1).trim() || undefined,
  };
}

function parseEducation(body: string[]): EducationEntry[] {
  const entries: EducationEntry[] = [];
  let current: EducationEntry | null = null;
  let eduNo = 0;
  const meta: string[] = [];

  const flush = () => {
    if (!current) return;
    // First two non-label meta lines are degree then dates.
    const nonLabel = meta.filter(
      (l) => !/^(coursework|honors|activities)/i.test(l),
    );
    if (nonLabel[0]) current.degree = nonLabel[0];
    if (nonLabel[1]) current.dates = nonLabel[1];
    for (const l of meta) {
      const cw = l.match(/^coursework\s*:?\s*(.+)$/i);
      if (cw) current.coursework = (cw[1] ?? "").trim();
      const hon = l.match(/^(?:honors[^:]*|activities)\s*:?\s*(.+)$/i);
      if (hon) current.honors = (hon[1] ?? "").trim();
    }
    entries.push(current);
    current = null;
    meta.length = 0;
  };

  for (const raw of body) {
    const line = raw.trim();
    if (!line) continue;
    const head = line.match(BOLD_HEAD_RE);
    if (head) {
      flush();
      eduNo++;
      current = { id: `EDU${eduNo}`, institution: (head[1] ?? "").trim(), degree: "", dates: "" };
    } else if (current) {
      meta.push(line);
    }
  }
  flush();
  return entries;
}

function parseSkills(body: string[]): SkillCategory[] {
  const out: SkillCategory[] = [];
  let n = 0;
  for (const raw of body) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(BOLD_HEAD_RE);
    if (!m) continue;
    n++;
    const category = (m[1] ?? "").replace(/:\s*$/, "").trim();
    const rest = (m[2] ?? "").replace(/^:\s*/, "").replace(/\\+\s*$/, "").trim();
    const items = rest
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    out.push({ id: `SKL${n}`, category, items });
  }
  return out;
}

/** Lower-cased set of skill items plus `/`-split sub-tokens (e.g. C/C++ → c, c++). */
function buildSkillVocabulary(skills: SkillCategory[]): string[] {
  const vocab = new Set<string>();
  for (const s of skills) {
    for (const item of s.items) {
      const base = item.replace(/\([^)]*\)/g, "").trim().toLowerCase();
      if (base) vocab.add(base);
      for (const part of base.split("/")) {
        const p = part.trim();
        if (p) vocab.add(p);
      }
    }
  }
  return [...vocab];
}

/**
 * Domain types for the parsed master CV.
 *
 * Every entry and every bullet carries a *stable* id (derived from its section
 * and position in cv.md). Those ids are the backbone of the anti-fabrication
 * guarantee: when the host model returns tailored content it must cite the
 * source id it rewrote, and the renderer verifies each id traces back here.
 */

export interface ContactLink {
  label: string;
  url: string;
}

export interface Contact {
  name: string;
  phone?: string;
  email?: string;
  links: ContactLink[];
}

export interface Bullet {
  /** e.g. "EXP1.2" — experience entry 1, bullet 2. */
  id: string;
  text: string;
}

export interface ExperienceEntry {
  /** e.g. "EXP1". */
  id: string;
  title: string;
  organization: string;
  location?: string;
  dates: string;
  bullets: Bullet[];
}

export interface ProjectEntry {
  /** e.g. "PRJ1". */
  id: string;
  name: string;
  /**
   * Optional project URL (Devpost, GitHub, live demo). Written in cv.md as a
   * markdown link in the heading: `**[Name](https://…)** - stack`. Rendered as
   * \href{url}{Name} so the compiled PDF keeps the hyperlink.
   */
  url?: string;
  /** Free-text tech stack line, e.g. "Swift, SwiftUI, ARKit, …". */
  stack: string;
  dates: string;
  bullets: Bullet[];
}

export interface EducationEntry {
  /** e.g. "EDU1". */
  id: string;
  institution: string;
  degree: string;
  dates: string;
  location?: string;
  coursework?: string;
  honors?: string;
}

export interface SkillCategory {
  /** e.g. "SKL1". */
  id: string;
  category: string;
  items: string[];
}

export interface MasterCv {
  contact: Contact;
  summary: string;
  experience: ExperienceEntry[];
  projects: ProjectEntry[];
  education: EducationEntry[];
  skills: SkillCategory[];
  /**
   * Flat provenance index: id → original source text. Includes every bullet id
   * and every entry heading id. Used to validate that tailored content is a
   * rewrite of something real, never an invention.
   */
  sourceIndex: Record<string, string>;
  /** Lower-cased set of every individual skill item, for skill provenance. */
  skillVocabulary: string[];
}

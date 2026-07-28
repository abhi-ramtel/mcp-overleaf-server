/**
 * Identity tailoring: map a parsed {@link MasterCv} straight to {@link TailoredContent}
 * with every bullet citing its own id. This is the zero-LLM baseline — a valid,
 * fully-provenanced document containing everything — used by tests and as a
 * fallback when no tailoring is requested.
 */
import type { MasterCv } from "./types.js";
import type { TailoredContent } from "./schema.js";

export function masterToTailored(cv: MasterCv): TailoredContent {
  return {
    summary: cv.summary,
    experience: cv.experience.map((e) => ({
      sourceId: e.id,
      title: e.title,
      organization: e.organization,
      location: e.location,
      dates: e.dates,
      bullets: e.bullets.map((b) => ({ text: b.text, sourceId: b.id })),
    })),
    projects: cv.projects.map((p) => ({
      sourceId: p.id,
      name: p.name,
      stack: p.stack,
      dates: p.dates,
      bullets: p.bullets.map((b) => ({ text: b.text, sourceId: b.id })),
    })),
    education: cv.education.map((ed) => ({
      sourceId: ed.id,
      institution: ed.institution,
      degree: ed.degree,
      dates: ed.dates,
      location: ed.location,
      coursework: ed.coursework,
      honors: ed.honors,
    })),
    skills: cv.skills.map((s) => ({ category: s.category, items: s.items })),
  };
}

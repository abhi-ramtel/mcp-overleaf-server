/**
 * Bridging the master CV and tailored content, in both directions.
 *
 * `masterToTailored` is the identity mapping — the zero-LLM baseline, a valid
 * fully-provenanced document containing everything, used by tests and as a
 * fallback when no tailoring is requested. `hydrateContent` goes the other way:
 * it fills the fields the host model deliberately left out of its answer with
 * the master CV's own values.
 */
import type { MasterCv } from "./types.js";
import type { TailoredBulletInput, TailoredContent, TailoredContentInput } from "./schema.js";

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
      url: p.url,
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

export interface HydrationResult {
  content: TailoredContent;
  /** Ids the master CV does not have, where provenance could not report them. */
  errors: string[];
}

/**
 * Expand the input shorthand into full {@link TailoredContent}.
 *
 * The host model sends only what it actually decided: which entries, in which
 * order, and the bullets it rewrote. Everything else — titles, organizations,
 * dates, project URLs, an unchanged bullet's text, a whole skill category — is
 * copied here from the master entry the sourceId names, instead of being
 * re-emitted token by token on every pass.
 *
 * Unknown entry and bullet ids are left in place: `checkProvenance` reports
 * them with its own message and hard-fails the render. Only skill-category ids,
 * which provenance never sees, are reported here.
 */
export function hydrateContent(cv: MasterCv, input: TailoredContentInput): HydrationResult {
  const errors: string[] = [];
  const experience = new Map(cv.experience.map((e) => [e.id, e]));
  const projects = new Map(cv.projects.map((p) => [p.id, p]));
  const education = new Map(cv.education.map((e) => [e.id, e]));
  const skills = new Map(cv.skills.map((s) => [s.id, s]));

  const bullets = (list: TailoredBulletInput[]): { text: string; sourceId: string }[] =>
    list.map((b) => {
      const sourceId = typeof b === "string" ? b : b.sourceId;
      const rewritten = typeof b === "string" ? undefined : b.text;
      // Falls back to "" only for an id the master CV lacks, which provenance
      // then hard-fails — no document is produced from it.
      return { sourceId, text: rewritten ?? cv.sourceIndex[sourceId] ?? "" };
    });

  const content: TailoredContent = {
    summary: input.summary,
    experience: input.experience.map((e) => {
      const src = experience.get(e.sourceId);
      return {
        sourceId: e.sourceId,
        title: e.title ?? src?.title ?? "",
        organization: e.organization ?? src?.organization ?? "",
        location: e.location ?? src?.location,
        dates: e.dates ?? src?.dates ?? "",
        bullets: bullets(e.bullets),
      };
    }),
    projects: input.projects.map((p) => {
      const src = projects.get(p.sourceId);
      return {
        sourceId: p.sourceId,
        name: p.name ?? src?.name ?? "",
        url: p.url ?? src?.url,
        stack: p.stack ?? src?.stack ?? "",
        dates: p.dates ?? src?.dates ?? "",
        bullets: bullets(p.bullets),
      };
    }),
    education: input.education.map((entry) => {
      const e = typeof entry === "string" ? { sourceId: entry } : entry;
      const src = education.get(e.sourceId);
      return {
        sourceId: e.sourceId,
        institution: e.institution ?? src?.institution ?? "",
        degree: e.degree ?? src?.degree ?? "",
        dates: e.dates ?? src?.dates ?? "",
        location: e.location ?? src?.location,
        coursework: e.coursework ?? src?.coursework,
        honors: e.honors ?? src?.honors,
      };
    }),
    skills: input.skills.flatMap((entry) => {
      if (typeof entry !== "string") return [entry];
      const src = skills.get(entry);
      if (!src) {
        errors.push(
          `skills: unknown category id "${entry}" — use an id from the master CV (SKL1, SKL2, …) or send {category, items}.`,
        );
        return [];
      }
      return [{ category: src.category, items: src.items }];
    }),
  };
  if (input.application) content.application = input.application;

  return { content, errors };
}

/**
 * The contract for tailored content the *host model* produces, plus the
 * deterministic provenance check that enforces "never fabricate".
 *
 * The host may reorder / rewrite / shorten / merge / emphasize existing bullets
 * — but every rendered bullet must cite the master-CV id it came from, and the
 * renderer verifies that here. Two extra guards target the spec's hard rules:
 *   • fabricated metrics — a number in a bullet that isn't in its source bullet
 *   • invented skills   — a skill absent from the master CV's skill vocabulary
 */
import { z } from "zod";
import type { MasterCv } from "./types.js";

export const TailoredBulletSchema = z.object({
  text: z.string().min(1),
  sourceId: z
    .string()
    .min(1)
    .describe("id of the master-CV bullet this was rewritten from, e.g. EXP1.2 or PRJ3.1"),
});

export const TailoredExperienceSchema = z.object({
  sourceId: z.string().min(1).describe("master experience entry id, e.g. EXP1"),
  title: z.string().min(1),
  organization: z.string().min(1),
  location: z.string().optional(),
  dates: z.string().min(1),
  bullets: z.array(TailoredBulletSchema).min(1),
});

export const TailoredProjectSchema = z.object({
  sourceId: z.string().min(1).describe("master project entry id, e.g. PRJ2"),
  name: z.string().min(1),
  url: z
    .string()
    .optional()
    .describe("project link from the master CV — pass it through so the name stays hyperlinked"),
  stack: z.string().default(""),
  dates: z.string().default(""),
  bullets: z.array(TailoredBulletSchema).min(1),
});

export const TailoredEducationSchema = z.object({
  sourceId: z.string().min(1).describe("master education entry id, e.g. EDU1"),
  institution: z.string().min(1),
  degree: z.string().default(""),
  dates: z.string().default(""),
  location: z.string().optional(),
  coursework: z.string().optional(),
  honors: z.string().optional(),
});

export const TailoredSkillCategorySchema = z.object({
  category: z.string().min(1),
  items: z.array(z.string().min(1)).min(1),
});

export const ApplicationMetaSchema = z.object({
  company: z.string().optional(),
  position: z.string().optional(),
  jobUrl: z.string().optional(),
});

export const TailoredContentSchema = z.object({
  summary: z.string().min(1),
  experience: z.array(TailoredExperienceSchema).default([]),
  projects: z.array(TailoredProjectSchema).default([]),
  education: z.array(TailoredEducationSchema).default([]),
  skills: z.array(TailoredSkillCategorySchema).default([]),
  /** Optional passthrough so the orchestration can carry company/position/url. */
  application: ApplicationMetaSchema.optional(),
});

export type TailoredBullet = z.infer<typeof TailoredBulletSchema>;
export type TailoredExperience = z.infer<typeof TailoredExperienceSchema>;
export type TailoredProject = z.infer<typeof TailoredProjectSchema>;
export type TailoredEducation = z.infer<typeof TailoredEducationSchema>;
export type TailoredSkillCategory = z.infer<typeof TailoredSkillCategorySchema>;
export type TailoredContent = z.infer<typeof TailoredContentSchema>;

export const CoverLetterContentSchema = z.object({
  company: z.string().min(1),
  position: z.string().min(1),
  /** Defaults to today, formatted "July 28, 2026". */
  date: z.string().optional(),
  /** e.g. "Hiring Team" or a named manager. */
  recipient: z.string().optional(),
  /** Optional address/location line under the recipient. */
  recipientAddress: z.string().optional(),
  /** Defaults to "Dear <recipient>,". */
  greeting: z.string().optional(),
  /** Body paragraphs, in order. Two to six keeps it to one page. */
  paragraphs: z.array(z.string().min(1)).min(2).max(6),
  /** Defaults to "Sincerely,". */
  closing: z.string().optional(),
});

export type CoverLetterContent = z.infer<typeof CoverLetterContentSchema>;

/**
 * Light-touch fabrication check for cover letters.
 *
 * Narrative prose can't carry per-bullet sourceIds, so instead of hard-failing
 * we flag the highest-risk pattern: a quantitative claim about the candidate
 * that doesn't appear anywhere in the master CV (e.g. "5 years of experience").
 * Numbers that belong to the employer (the company name, the role) are ignored
 * by comparing only against the CV's own numeric vocabulary.
 */
export function checkCoverLetterClaims(
  masterCvText: string,
  content: CoverLetterContent,
): ProvenanceReport {
  const warnings: string[] = [];
  const cvNums = numbersIn(masterCvText);
  // Numbers appearing in the company/position are the employer's, not claims.
  const contextNums = numbersIn(`${content.company} ${content.position}`);

  content.paragraphs.forEach((para, i) => {
    for (const n of numbersIn(para)) {
      if (cvNums.has(n) || contextNums.has(n)) continue;
      warnings.push(
        `paragraph ${i + 1}: states "${n}", which does not appear in your master CV — verify it is not an invented figure.`,
      );
    }
  });

  return { ok: true, errors: [], warnings };
}

export interface ProvenanceReport {
  /** false when any hard error is present — the render tool refuses to compile. */
  ok: boolean;
  /** Hard failures: a cited id doesn't exist in the master CV. */
  errors: string[];
  /** Soft flags for human review: new numbers, invented skills. */
  warnings: string[];
}

const NUM_RE = /\d[\d,]*(?:\.\d+)?x?%?/gi;

/** Normalized numeric tokens in a string (commas stripped), e.g. {"60%","720000"}. */
function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(NUM_RE)) {
    const tok = (m[0] ?? "").replace(/,/g, "").toLowerCase();
    if (tok) out.add(tok);
  }
  return out;
}

function normSkill(item: string): string {
  return item.replace(/\([^)]*\)/g, "").trim().toLowerCase();
}

/**
 * Verify every tailored item traces back to the master CV.
 * Unknown ids are hard errors; new metrics and invented skills are warnings.
 */
export function checkProvenance(master: MasterCv, content: TailoredContent): ProvenanceReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const idx = master.sourceIndex;

  const checkBullets = (
    bullets: TailoredBullet[],
    label: string,
  ): void => {
    for (const b of bullets) {
      const src = idx[b.sourceId];
      if (src === undefined) {
        errors.push(`${label}: bullet cites unknown sourceId "${b.sourceId}"`);
        continue;
      }
      const srcNums = numbersIn(src);
      for (const n of numbersIn(b.text)) {
        if (!srcNums.has(n)) {
          warnings.push(
            `${label} (${b.sourceId}): introduces number "${n}" absent from the source bullet — confirm it is not a fabricated metric.`,
          );
        }
      }
    }
  };

  for (const e of content.experience) {
    if (idx[e.sourceId] === undefined) {
      errors.push(`experience: unknown entry sourceId "${e.sourceId}"`);
    }
    checkBullets(e.bullets, `experience ${e.sourceId}`);
  }
  for (const p of content.projects) {
    if (idx[p.sourceId] === undefined) {
      errors.push(`projects: unknown entry sourceId "${p.sourceId}"`);
    }
    checkBullets(p.bullets, `project ${p.sourceId}`);
  }
  for (const ed of content.education) {
    if (idx[ed.sourceId] === undefined) {
      errors.push(`education: unknown entry sourceId "${ed.sourceId}"`);
    }
  }

  const vocab = new Set(master.skillVocabulary);
  for (const cat of content.skills) {
    for (const item of cat.items) {
      const norm = normSkill(item);
      const known = vocab.has(norm) || norm.split("/").some((p) => vocab.has(p.trim()));
      if (!known) {
        warnings.push(
          `skills: "${item}" is not in your master CV skills — confirm it is a real skill before sending.`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

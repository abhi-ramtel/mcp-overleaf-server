/**
 * Build the "tailoring brief" — the single payload returned by prepare_tailoring.
 * It gives the host model everything needed to produce TailoredContent JSON:
 * the master CV with stable ids, deterministic JD keyword signals, the strict
 * anti-fabrication rules, and the exact output schema with an example.
 *
 * The server does no LLM work; this brief is the interface to the host's model.
 */
import { extractKeywords, keywordGap } from "./keywords.js";
import type { MasterCv } from "./types.js";

export interface BriefOptions {
  jobDescription: string;
  masterCvText: string;
  company?: string;
  position?: string;
  jobUrl?: string;
  template?: "resume" | "cv";
  /** Application-portal questions to answer in chat (not in any document). */
  questions?: string[];
}

/** Compact, id-annotated view of the master CV the host must draw from. */
export function masterCvForBrief(cv: MasterCv): unknown {
  return {
    contact: cv.contact,
    summary: { id: "SUM", text: cv.summary },
    experience: cv.experience.map((e) => ({
      id: e.id,
      title: e.title,
      organization: e.organization,
      location: e.location,
      dates: e.dates,
      bullets: e.bullets.map((b) => ({ id: b.id, text: b.text })),
    })),
    projects: cv.projects.map((p) => ({
      id: p.id,
      name: p.name,
      url: p.url,
      stack: p.stack,
      dates: p.dates,
      bullets: p.bullets.map((b) => ({ id: b.id, text: b.text })),
    })),
    education: cv.education.map((ed) => ({
      id: ed.id,
      institution: ed.institution,
      degree: ed.degree,
      dates: ed.dates,
      location: ed.location,
      coursework: ed.coursework,
      honors: ed.honors,
    })),
    skills: cv.skills.map((s) => ({ id: s.id, category: s.category, items: s.items })),
  };
}

const RULES = `## Absolute rules (truthfulness > keyword matching)

You may ONLY: reorder, rewrite, shorten, prioritize, merge, remove, or emphasize
information that already exists in the master CV below.

You must NEVER invent: experiences, companies, internships, projects, skills you
do not have, or metrics/numbers. Do not add a number to a bullet unless that exact
number is already in the source bullet.

Every bullet you output MUST cite the "sourceId" of the master-CV bullet it was
rewritten from (e.g. "EXP1.2"). Every experience/project/education entry MUST cite
the entry id it came from (e.g. "EXP1"). The server rejects any id it cannot trace
back to the master CV, and flags any new number or skill for review.`;

const ATS_GUIDANCE = `## ATS optimization

- Naturally weave in the job description's terminology and the "addable keywords"
  below — but only where it's truthful. No keyword stuffing.
- Lead bullets with strong action verbs; keep quantified impact that already exists.
- Drop weak or irrelevant bullets; prioritize the most relevant experience/projects.

## Page density — FILL the page

The target is one page that is *full*, not one page that is half empty. A résumé
ending two-thirds down the page wastes the most valuable space you have.

- **THREE bullets for every experience entry.** Not one, not two — three.
- **At least TWO bullets for every project.** Three for the most relevant ones.
- Include roughly **3 experiences and 3-4 projects**, then adjust to fit.
- Bullets should be substantial: a full line or two of real detail, not four words.
- Only trim if the render actually reports more than one page. Under-filling is
  the more common failure, and it looks worse than a dense page.`;

const SCHEMA_DOC = `## Output: a single JSON object (TailoredContent)

{
  "summary": "string — 2-3 lines, tailored to the role",
  "experience": [
    {
      "sourceId": "EXP1",                // master experience entry id
      "title": "string",
      "organization": "string",
      "location": "string (optional)",
      "dates": "string",
      "bullets": [
        { "text": "rewritten bullet", "sourceId": "EXP1.2" }
      ]
    }
  ],
  "projects": [
    {
      "sourceId": "PRJ2",
      "name": "string",
      "url": "string (optional) — copy the project's url from the master CV verbatim so the PDF keeps the link",
      "stack": "string (comma-separated tech)",
      "dates": "string",
      "bullets": [ { "text": "...", "sourceId": "PRJ2.1" } ]
    }
  ],
  "education": [
    {
      "sourceId": "EDU1",
      "institution": "string",
      "degree": "string",
      "dates": "string",
      "location": "string (optional)",
      "coursework": "string (optional)",
      "honors": "string (optional)"
    }
  ],
  "skills": [ { "category": "string", "items": ["string", "..."] } ],
  "application": { "company": "...", "position": "...", "jobUrl": "..." }
}`;

/** Assemble the full brief as markdown text. */
export function buildTailoringBrief(cv: MasterCv, opts: BriefOptions): string {
  const keywords = extractKeywords(opts.jobDescription);
  const gap = keywordGap(keywords, "", opts.masterCvText); // resume text empty → all keywords classified
  const target = opts.template === "cv" ? "one-page CV" : "one-page resume";

  const nextStep =
    "Produce the TailoredContent JSON, then call `render_and_compile` with it, passing " +
    `template="${opts.template ?? "resume"}"` +
    (opts.company ? `, company="${opts.company}"` : "") +
    (opts.position ? `, position="${opts.position}"` : "") +
    ", and the original jobDescription (for an ATS coverage report). " +
    "Review any provenance warnings it returns before finalizing.";

  const sections: string[] = [
    `# Tailoring brief — produce a tailored ${target}`,
  ];
  if (opts.company || opts.position) {
    sections.push(
      `Target: **${opts.position ?? "role"}** at **${opts.company ?? "company"}**${opts.jobUrl ? ` (${opts.jobUrl})` : ""}`,
    );
  }
  sections.push(
    RULES,
    ATS_GUIDANCE,
    ["## Job description", "", "```", opts.jobDescription.trim(), "```"].join("\n"),
    [
      "## JD keyword signals (deterministic)",
      "",
      `Top keywords: ${keywords.join(", ") || "(none extracted)"}`,
      "",
      `Addable (already in your master CV — safe to emphasize): ${gap.addable.join(", ") || "(none)"}`,
      "",
      `Absent (NOT in your master CV — do not add, would be fabrication): ${gap.absent.join(", ") || "(none)"}`,
    ].join("\n"),
    ["## Master CV (draw only from this; cite these ids)", "", "```json", JSON.stringify(masterCvForBrief(cv), null, 2), "```"].join("\n"),
    SCHEMA_DOC,
  );

  if (opts.questions && opts.questions.length > 0) {
    sections.push(
      [
        "## Application questions (answer in chat — these do NOT go in any document)",
        "",
        "The portal asks the following. Draft an answer for each, then show them in your reply so they can be",
        "pasted into the application. Rules:",
        "",
        "- First person, 3-6 sentences, specific and plain — no corporate filler.",
        "- Ground every claim in the master CV above. Do not invent employers, projects, or figures.",
        "- Reference this company and role concretely, using details from the job description.",
        "- If a question asks about preferences, working style, or motivation, answer honestly from what the CV",
        "  actually evidences (what was built, owned, shipped) rather than inventing traits.",
        "- If a question cannot be answered truthfully from the CV, say so plainly and suggest what the user",
        "  would need to supply.",
        "",
        ...opts.questions.map((q, i) => `${i + 1}. ${q.trim()}`),
      ].join("\n"),
    );
  }

  sections.push(["## Next step", "", nextStep].join("\n"));
  return sections.join("\n\n");
}

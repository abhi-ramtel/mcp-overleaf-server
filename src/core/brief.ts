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
  /** Whether to generate a matching cover letter (default true). */
  coverLetter?: boolean;
  /** Application-portal questions to answer in chat (not in any document). */
  questions?: string[];
}

/**
 * Terse, id-tagged view of the master CV — the payload the host model draws
 * from on every tailoring pass.
 *
 * The format is chosen for size, not prettiness: the same content as
 * pretty-printed JSON runs ~35 KB (~8.7k tokens), nearly half of it repeated
 * object keys and indentation, and it is re-sent with every brief. Pipe-
 * delimited lines carry the same fields and the same ids at roughly half that.
 * A blank field means the master CV has none.
 */
export function masterCvOutline(cv: MasterCv): string {
  const row = (...fields: (string | undefined)[]): string =>
    fields.map((f) => (f ?? "").trim()).join(" | ");
  const bullets = (entry: { bullets: { id: string; text: string }[] }): string[] =>
    entry.bullets.map((b) => `  ${b.id} ${b.text}`);

  const contact = [cv.contact.name, cv.contact.email, cv.contact.phone]
    .concat(cv.contact.links.map((l) => `${l.label} <${l.url}>`))
    .filter((f): f is string => !!f && f.trim().length > 0);

  const lines: string[] = [`CONTACT | ${contact.join(" | ")}`, `SUM | ${cv.summary}`];

  lines.push("", "EXPERIENCE — id | title | organization | location | dates");
  for (const e of cv.experience) {
    lines.push(row(e.id, e.title, e.organization, e.location, e.dates), ...bullets(e));
  }

  lines.push("", "PROJECTS — id | name | url | stack | dates");
  for (const p of cv.projects) {
    lines.push(row(p.id, p.name, p.url, p.stack, p.dates), ...bullets(p));
  }

  lines.push("", "EDUCATION — id | institution | degree | dates | location | coursework | honors");
  for (const ed of cv.education) {
    lines.push(row(ed.id, ed.institution, ed.degree, ed.dates, ed.location, ed.coursework, ed.honors));
  }

  lines.push("", "SKILLS — id | category | items");
  for (const s of cv.skills) lines.push(row(s.id, s.category, s.items.join(", ")));

  return lines.join("\n");
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

const POSITIONING_GUIDANCE = `## Positioning — anchor the whole résumé on ONE theme

A résumé that spans full-stack, backend, systems, and AI infrastructure at once
reads as broad and scattered: the screener cannot tell what the core
specialization is, and range dilutes the perceived depth in any one area.
Clarity in the first six seconds beats breadth.

- Before writing, pick ONE theme from the job description that the master CV
  can truthfully support, e.g. low-latency / performance-critical systems,
  AI/LLM infrastructure, distributed backend systems, or security engineering.
  Name the theme in one line of your reply so the user can see the choice.
- The summary opens with that theme as the candidate's identity and backs it
  with the strongest one or two pieces of evidence. Do not list every domain the
  candidate has touched; leave out areas this role does not need.
- Every selected entry reinforces the theme. The theme decides WHICH entries
  fill the page baseline below and HOW each is framed; it never shrinks the
  baseline.
  - Within each entry, choose and order the source bullets that show on-theme
    work first.
  - When choosing projects, prefer on-theme projects over off-theme ones.
  - Off-theme work (e.g. frontend/UI or IT support on a systems résumé)
    competes with the narrative instead of reinforcing it. If an off-theme entry
    stays for chronology or density, use its source bullets that show the
    on-theme angle (backend, performance, concurrency, reliability, scale,
    security). Never invent that angle.
- Skills: lead with the categories and items that support the theme, and drop
  items that pull against it (e.g. frontend frameworks on a systems résumé)
  unless the job description asks for them.`;

const IMPACT_GUIDANCE = `## Measurable, system-level impact

Systems and AI-infrastructure hiring teams scan for outcomes: latency,
throughput, scale, efficiency, and reliability. A bullet that names a
technology without its result undersells the work.

- Every number in a selected source bullet must survive the rewrite. Put it
  where it is seen, usually right after the verb ("Cut runtime <N>% by
  restructuring ..."), and never soften a real figure into "improved
  performance".
- When choosing among an entry's source bullets, prefer the ones listed under
  "Quantified source bullets" below; sending one as just its id keeps its
  number exactly as written. Carry a number only from the bullet you
  cite as its sourceId; the provenance check compares numbers per cited bullet.
- Shape each bullet as action + system + technique + measurable outcome. Name
  the technique that produced the result (multithreading, shared memory,
  vectorization, caching, memory layout) when the source names it.
- Use the vocabulary these roles are screened on (performance benchmarking,
  memory optimization, concurrency control, distributed-system reliability,
  production-scale deployment) only where the source evidence shows it.
- For a bullet whose source has no number, state the concrete system-level
  outcome the source does describe (what got faster, scaled, or became more
  reliable, and at what scale) instead of a task description. Do NOT invent a
  number or a scale.
- In your final reply, list each bullet you used that still has no measurable
  outcome, and suggest the kind of metric the user could add to cv.md (e.g. p99
  latency before/after, requests/sec, dataset size). Phrase these as questions
  for the user, never as claims.`;

/**
 * A measurable outcome: a percentage, multiplier, "N+" count, money, a time or
 * size unit, a magnitude word, or a before → after range. Bare numbers (years,
 * versions, course codes) are deliberately not counted.
 */
const METRIC_RE =
  /\$\s?\d|\d\s?(?:%|×|x\b|\+)|\d\s?(?:ms|µs|ns|sec|seconds?|minutes?|hours?|[kmgt]b)\b|\b(?:thousand|million|billion)\b|\d[\d,.]*\s+to\s+\d/i;

/** Ids of experience/project bullets that already carry a measurable outcome. */
export function quantifiedBulletIds(cv: MasterCv): string[] {
  return [...cv.experience, ...cv.projects]
    .flatMap((entry) => entry.bullets)
    .filter((b) => METRIC_RE.test(b.text))
    .map((b) => b.id);
}

const ATS_GUIDANCE = `## ATS optimization

- Naturally weave in the job description's terminology and the "addable keywords"
  below — but only where it's truthful. No keyword stuffing.
- Lead bullets with strong action verbs; keep quantified impact that already exists.
- Drop weak or irrelevant bullets; prioritize the most relevant experience/projects.

## Page density and visual quality — FILL the page naturally

The target is one page that is *full*, not one page that is half empty. A résumé
ending two-thirds down the page wastes the most valuable space you have.

- **THREE bullets for every experience entry.** Not one, not two — three.
- Prefer **four relevant experience entries** when the master CV has them — this
  is one more than the usual bare-minimum three. Do not add an entry that is not
  in the master CV just to reach four.
- Start with **four experience entries and three projects** when the master CV
  supplies them. This is the default content baseline, not an optional maximum.
- Give **THREE distinct sourced bullets to every selected project** when that
  project has three source bullets. If it has fewer, use every available source
  bullet; never duplicate or invent one just to hit the count.
- With four roles and three projects, the normal target is **21 bullets**
  (4 × 3 experience + 3 × 3 project). Do not cut below this just because the
  résumé seems likely to fit. Only remove content after the actual PDF reports
  more than one page.
- Bullets should be substantial: a full line or two of real detail, not four words.
- Match the compactness of the existing LaTeX template, not merely its page
  count. A one-page PDF with a large empty lower third is under-filled. Retain
  useful source detail so selected bullets naturally wrap where warranted; do
  not make them terse simply to fit. If the rendered PDF still has substantial
  lower-page whitespace, add a relevant sourced project or another detailed
  sourced bullet before considering a layout change.
- Only trim if the render actually reports more than one page. Under-filling is
  the more common failure, and it looks worse than a dense page.`;

const PRESENTATION_GUIDANCE = `## Presentation and skills fidelity

- Fill the page with truthful, relevant evidence — **never** by shrinking the
  font, tightening margins, or changing the document's visual design. The
  renderer preserves the résumé template's professional, standard type scale.
- Keep the master CV's top-level skill category labels verbatim whenever they
  are included. Select and reorder the existing skill items for relevance, but
  do not invent category labels or job-description-derived skills. This avoids
  provenance warnings and keeps the skills section clean and readable.
- Prefer a focused, balanced layout: a concise 2-3 line summary that opens
  with the chosen theme, four strong experience entries and three substantial
  projects when available. Keep that evidence in the first render; do not prune
  a relevant role or project merely because it is less central than the top
  match. Do not fill space with keyword lists or weak bullets.`;

const VOICE_GUIDANCE = `## Voice — the prose a person actually reads

The summary, the cover letter, and any application-question answers are read by a
human, not an ATS. Load the \`humane-writing\` skill if this session has it and run
its pre-send checklist over each of them. Without it, at minimum: no em dashes
unless the interruption is the point, no "not just X, it's Y" framing, no
three-item lists, none of leverage / robust / seamless / passionate / proven track
record / extensive experience, no "In today's ..." opener, and no closer a form
letter could carry. Vary sentence length.

Specificity is what replaces all that, and it comes from the master CV only: name
a system, a number, or an artifact already recorded there. Never invent a figure
to sound concrete — every number absent from the CV is flagged for review.

Résumé bullets are exempt. They are provenance-locked rewrites of master-CV lines;
write them to the rules above this section instead.`;

const SCHEMA_DOC = `## Output: a single JSON object (TailoredContent)

Send only what you decided. Anything the master CV already holds is filled in by
id — do not copy it back:

- a bullet you kept as-is is just its id: "EXP1.2"
- a bullet you rewrote is { "text": "...", "sourceId": "EXP1.2" }
- an entry's title / organization / location / dates — and a project's name, url
  and stack — come from the entry its sourceId names. Include one only to
  override it. Project links are preserved automatically.
- an education entry is normally just its id: "EDU1"
- a skill category kept whole is just its id: "SKL3". To trim its items, send
  { "category": "...", "items": [...] } keeping the master CV's own label.

{
  "summary": "string — 2-3 lines, opening with the one theme chosen for this role (always your own words)",
  "experience": [
    {
      "sourceId": "EXP1",
      "bullets": ["EXP1.1", { "text": "rewritten bullet", "sourceId": "EXP1.3" }]
    }
  ],
  "projects": [
    { "sourceId": "PRJ2", "bullets": ["PRJ2.1", { "text": "...", "sourceId": "PRJ2.2" }] }
  ],
  "education": ["EDU1"],
  "skills": ["SKL1", { "category": "Cloud & Infrastructure", "items": ["AWS", "Docker"] }],
  "application": { "company": "...", "position": "...", "jobUrl": "..." }
}

Every id must trace back to the master CV above; the server rejects any it
cannot resolve.`;

/** Assemble the full brief as markdown text. */
export function buildTailoringBrief(cv: MasterCv, opts: BriefOptions): string {
  const keywords = extractKeywords(opts.jobDescription);
  const gap = keywordGap(keywords, "", opts.masterCvText); // resume text empty → all keywords classified
  const target = opts.template === "cv" ? "one-page CV" : "one-page resume";

  const coverLetterInstruction =
    opts.coverLetter === false
      ? " The user explicitly set CoverLetter:false. Do NOT pass `coverLetter` to `render_and_compile` and do not generate a cover letter."
      : " Also pass a CV-grounded `coverLetter` unless the user explicitly opts out, written to the Voice section " +
        "above; this produces the matching letter in the same call.";
  const nextStep =
    "Produce the TailoredContent JSON, then call `render_and_compile` with it, passing " +
    `template="${opts.template ?? "resume"}"` +
    (opts.company ? `, company="${opts.company}"` : "") +
    (opts.position ? `, position="${opts.position}"` : "") +
    ", and the original jobDescription (for an ATS coverage report). " +
    "Review any provenance warnings it returns before finalizing. In your reply, name the theme you " +
    "anchored on and list any bullets that still lack a measurable outcome." +
    coverLetterInstruction;

  const sections: string[] = [
    `# Tailoring brief — produce a tailored ${target}`,
  ];
  if (opts.company || opts.position) {
    sections.push(
      `Target: **${opts.position ?? "role"}** at **${opts.company ?? "company"}**${opts.jobUrl ? ` (${opts.jobUrl})` : ""}`,
    );
  }
  const quantified = quantifiedBulletIds(cv);
  sections.push(
    RULES,
    POSITIONING_GUIDANCE,
    IMPACT_GUIDANCE,
    ATS_GUIDANCE,
    PRESENTATION_GUIDANCE,
    VOICE_GUIDANCE,
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
    [
      "## Quantified source bullets (prefer these; keep their numbers)",
      "",
      quantified.length
        ? quantified.join(", ")
        : "(none: no source bullet carries a measurable outcome, so frame concrete system-level outcomes and tell the user which metrics to add to cv.md)",
    ].join("\n"),
    ["## Master CV (draw only from this; cite these ids)", "", "```", masterCvOutline(cv), "```"].join("\n"),
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
        "- First person, 3-6 sentences, specific and plain. Apply the Voice section above: a person reads these.",
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

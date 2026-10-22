/**
 * The input shorthand: what the host model may leave out because the master CV
 * already has it, and what must still be its own words.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCv } from "../src/core/cvParser.js";
import { hydrateContent, masterToTailored } from "../src/core/tailoring.js";
import { TailoredContentInputSchema, checkProvenance } from "../src/core/schema.js";
import { loadMasterCv, runRenderPipeline } from "../src/core/pipeline.js";
import { escapeLatex } from "../src/core/latexRenderer.js";
import { readFile } from "node:fs/promises";

const CV = `# Ada Lovelace

\`+1 555-0100\` | \`ada@example.com\` | [GitHub](https://github.com/ada)

## Summary

Engineer.

## Experience

**Staff Engineer** - Analytical Engines, London, UK
Jan 2024 - Present
- Cut batch latency by 40% across the card reader.
- Mentored three engineers.

## Projects

**[Difference Engine](https://example.com/de)** - Rust, WASM
2023
- Built a column-oriented store.
- Shipped a WASM playground.

## Education

**University of London**
BSc Mathematics
2020 - 2024

## Skills

**Languages:** Rust, Python
**Tools:** Git, Docker
`;

const cv = parseCv(CV);

test("bare ids expand to the master CV's own text and headings", () => {
  const input = TailoredContentInputSchema.parse({
    summary: "Backend engineer.",
    experience: [{ sourceId: "EXP1", bullets: ["EXP1.1", { sourceId: "EXP1.2", text: "Mentored two engineers." }] }],
    projects: [{ sourceId: "PRJ1", bullets: ["PRJ1.1"] }],
    education: ["EDU1"],
    skills: ["SKL1"],
  });
  const { content, errors } = hydrateContent(cv, input);

  assert.deepEqual(errors, []);
  const exp = content.experience[0]!;
  assert.equal(exp.title, "Staff Engineer", "title copied from the master entry");
  assert.equal(exp.organization, "Analytical Engines");
  assert.equal(exp.dates, "Jan 2024 - Present");
  assert.equal(exp.location, "London, UK");
  assert.equal(exp.bullets[0]!.text, "Cut batch latency by 40% across the card reader.", "bare id keeps the source text");
  assert.equal(exp.bullets[1]!.text, "Mentored two engineers.", "a supplied rewrite wins");

  const prj = content.projects[0]!;
  assert.equal(prj.name, "Difference Engine");
  assert.equal(prj.url, "https://example.com/de", "the project link survives, so the PDF stays hyperlinked");
  assert.equal(prj.stack, "Rust, WASM");

  const edu = content.education[0]!;
  assert.equal(edu.institution, "University of London");
  assert.equal(edu.degree, "BSc Mathematics");

  assert.deepEqual(content.skills, [{ category: "Languages", items: ["Rust", "Python"] }]);
  assert.equal(checkProvenance(cv, content).ok, true, "hydrated content passes the anti-fabrication check");
});

test("supplied fields override the master CV and an unknown skill id is refused", () => {
  const input = TailoredContentInputSchema.parse({
    summary: "s",
    experience: [{ sourceId: "EXP1", title: "Backend Engineer", bullets: ["EXP1.1"] }],
    skills: [{ category: "Languages", items: ["Rust"] }, "SKL9"],
  });
  const { content, errors } = hydrateContent(cv, input);

  assert.equal(content.experience[0]!.title, "Backend Engineer");
  assert.equal(content.experience[0]!.organization, "Analytical Engines", "unstated fields still come from the master");
  assert.deepEqual(content.skills, [{ category: "Languages", items: ["Rust"] }], "the unknown id is dropped, not guessed");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /unknown category id "SKL9"/);
});

test("the shorthand reproduces the full form exactly, on the real master CV", async () => {
  const master = await loadMasterCv();
  const full = masterToTailored(master);
  const shorthand = TailoredContentInputSchema.parse({
    summary: full.summary,
    experience: master.experience.map((e) => ({ sourceId: e.id, bullets: e.bullets.map((b) => b.id) })),
    projects: master.projects.map((p) => ({ sourceId: p.id, bullets: p.bullets.map((b) => b.id) })),
    education: master.education.map((e) => e.id),
    skills: master.skills.map((s) => s.id),
  });
  const { content, errors } = hydrateContent(master, shorthand);

  assert.deepEqual(errors, []);
  assert.deepEqual(content, full, "ids alone rebuild the same document the long form produces");
});

test("the render pipeline accepts the shorthand and puts the master CV's own text in the .tex", async () => {
  const master = await loadMasterCv();
  const exp = master.experience[0]!;
  const out = await runRenderPipeline({
    content: {
      summary: "Backend engineer.",
      experience: [{ sourceId: exp.id, bullets: [exp.bullets[0]!.id] }],
      education: master.education.map((e) => e.id),
      skills: [master.skills[0]!.id],
    },
    outputName: "HydrateShorthandTest",
    compile: false,
  });

  assert.equal(out.ok, true, out.error);
  const tex = await readFile(out.texPath!, "utf-8");
  for (const field of [exp.title, exp.organization]) {
    assert.ok(tex.includes(escapeLatex(field)), `"${field}" was filled in from the master CV, not sent by the caller`);
  }
  // The renderer normalizes "-" to an en dash, so match the date's leading token.
  assert.ok(tex.includes(escapeLatex(exp.dates.split(" - ")[0]!)), "dates came from the master entry too");
  assert.ok(tex.includes(escapeLatex(master.skills[0]!.items[0]!)), "the skill category expanded from its id");
});

test("an unknown skill id fails the render instead of silently dropping a section", async () => {
  const master = await loadMasterCv();
  const out = await runRenderPipeline({
    content: { summary: "s", experience: [{ sourceId: master.experience[0]!.id, bullets: [master.experience[0]!.bullets[0]!.id] }], skills: ["SKL99"] },
    outputName: "HydrateBadSkillTest",
    compile: false,
  });

  assert.equal(out.ok, false);
  assert.match(out.error ?? "", /unknown category id "SKL99"/);
});

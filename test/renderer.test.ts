import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseCvFile } from "../src/core/cvParser.js";
import { renderTemplate, escapeLatex } from "../src/core/latexRenderer.js";
import { masterToTailored } from "../src/core/tailoring.js";
import { config } from "../src/config.js";
import * as path from "node:path";

test("escapeLatex escapes special characters and normalizes unicode", () => {
  assert.equal(escapeLatex("increased throughput by 60%"), "increased throughput by 60\\%");
  assert.equal(escapeLatex("Backend & APIs"), "Backend \\& APIs");
  assert.equal(escapeLatex("a — b"), "a - b"); // em-dash normalized
  assert.equal(escapeLatex("C_underscore #hash $money"), "C\\_underscore \\#hash \\$money");
});

test("renders cv-template.tex with no unresolved placeholders", async () => {
  const cv = await parseCvFile(config.cvMasterPath);
  const content = masterToTailored(cv);
  const template = await readFile(path.join(config.templatesDir, "cv-template.tex"), "utf-8");
  const tex = renderTemplate(template, cv, content);

  const leftover = tex.match(/\{\{[A-Z_]+\}\}/g);
  assert.equal(leftover, null, `unresolved placeholders: ${leftover?.join(", ")}`);
  assert.match(tex, /\\resumeSubheading/);
  assert.match(tex, /\\resumeProjectHeading/);
  assert.match(tex, /\\resumeItem\{/);
  assert.match(tex, /\\begin\{document\}/);
  assert.match(tex, /\\end\{document\}/);
});

test("renders resume-template.tex including the summary", async () => {
  const cv = await parseCvFile(config.cvMasterPath);
  const content = masterToTailored(cv);
  const template = await readFile(path.join(config.templatesDir, "resume-template.tex"), "utf-8");
  const tex = renderTemplate(template, cv, content);

  assert.equal(tex.match(/\{\{[A-Z_]+\}\}/g), null);
  assert.ok(tex.includes(escapeLatex(cv.summary).slice(0, 30)), "summary rendered");
  assert.match(tex, /\\section\{Summary\}/);
});

test("experience uses {org}{dates}{title}{loc} order; email has single mailto", async () => {
  const cv = await parseCvFile(config.cvMasterPath);
  const content = masterToTailored(cv);
  const template = await readFile(path.join(config.templatesDir, "cv-template.tex"), "utf-8");
  const tex = renderTemplate(template, cv, content);

  // First \resumeSubheading must render EXP1 in {org}{dates}{title}{loc} order —
  // derived from the parsed CV so editing cv.md never breaks this test.
  const e0 = cv.experience[0]!;
  // Scope to the Experience section — Education also uses \resumeSubheading and
  // renders before Experience in cv-template.tex.
  const expSlice = tex.slice(Math.max(0, tex.indexOf("Work Experience")));
  const m = expSlice.match(/\\resumeSubheading\s*\n\s*\{([^}]*)\}\{([^}]*)\}\s*\n\s*\{([^}]*)\}\{([^}]*)\}/);
  assert.ok(m, "first \\resumeSubheading present");
  assert.equal(m![1], escapeLatex(e0.organization));
  assert.equal(m![2], escapeLatex(e0.dates));
  assert.equal(m![3], escapeLatex(e0.title));
  assert.equal(m![4], escapeLatex(e0.location ?? ""));

  // no double mailto bug; email href comes straight from the parsed contact
  assert.ok(!tex.includes("mailto:mailto:"));
  if (cv.contact.email) assert.ok(tex.includes(`\\href{mailto:${cv.contact.email}}`));
});

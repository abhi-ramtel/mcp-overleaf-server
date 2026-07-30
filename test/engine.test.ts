import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCvFile } from "../src/core/cvParser.js";
import { renderTemplate } from "../src/core/latexRenderer.js";
import { masterToTailored } from "../src/core/tailoring.js";
import { validateTex } from "../src/core/latexValidate.js";
import { compileTex } from "../src/core/latexCompile.js";
import { extractKeywords, scoreCoverage, keywordGap } from "../src/core/keywords.js";
import { config } from "../src/config.js";

test("validateTex accepts a rendered template and rejects broken ones", async () => {
  const cv = await parseCvFile(config.cvMasterPath);
  const tpl = await readFile(join(config.templatesDir, "resume-template.tex"), "utf-8");
  const tex = renderTemplate(tpl, cv, masterToTailored(cv));

  const ok = validateTex(tex);
  assert.equal(ok.valid, true, ok.errors.join("; "));
  assert.ok(ok.counts.resumeItems > 0);

  assert.equal(validateTex(tex.replace("\\end{document}", "")).valid, false);
  assert.equal(validateTex(tex + "\n{{LEFTOVER}}").valid, false);
});

test("extractKeywords ranks JD terms and drops stopwords", () => {
  const jd = `We are looking for a Backend Engineer with strong Go and Kubernetes experience.
    You will design distributed systems, build REST APIs, and work with PostgreSQL and gRPC.
    Experience with machine learning and CI/CD is a plus.`;
  const kws = extractKeywords(jd, { max: 25 });
  assert.ok(kws.includes("kubernetes"));
  assert.ok(kws.includes("postgresql"));
  assert.ok(kws.includes("go"));
  assert.ok(kws.some((k) => k === "distributed systems"));
  assert.ok(!kws.includes("experience"), "stopword removed");
  assert.ok(!kws.includes("looking"), "boilerplate removed");
});

test("scoreCoverage and keywordGap separate addable vs absent", async () => {
  const cv = await parseCvFile(config.cvMasterPath);
  const masterText = await readFile(config.cvMasterPath, "utf-8");
  const kws = ["go", "postgresql", "kubernetes", "rust", "cobol"];
  // A resume text that mentions Go but not the rest.
  const resumeText = "Built a payments platform in Go with microservices.";

  const cov = scoreCoverage(kws, resumeText);
  assert.ok(cov.matched.includes("go"));
  assert.ok(cov.missing.includes("postgresql"));
  assert.equal(cov.percent, 20);

  const gap = keywordGap(kws, resumeText, masterText);
  // postgresql, kubernetes, rust are in the master CV → addable; cobol is not → absent.
  assert.ok(gap.addable.includes("postgresql"));
  assert.ok(gap.addable.includes("rust"));
  assert.ok(gap.absent.includes("cobol"));
  assert.ok(!gap.addable.includes("cobol"));
  void cv;
});

test("compileTex produces a real PDF from the rendered resume", async () => {
  const cv = await parseCvFile(config.cvMasterPath);
  const tpl = await readFile(join(config.templatesDir, "resume-template.tex"), "utf-8");
  const tex = renderTemplate(tpl, cv, masterToTailored(cv));

  const dir = tmpdir();
  const texPath = join(dir, `mcp-compile-test-${process.pid}.tex`);
  const pdfPath = join(dir, `mcp-compile-test-${process.pid}.pdf`);
  await (await import("node:fs/promises")).writeFile(texPath, tex, "utf-8");

  const result = await compileTex(texPath, { outPdfPath: pdfPath });
  assert.equal(result.compiled, true, result.error);
  assert.ok(result.pdfPath);
  assert.ok((result.sizeBytes ?? 0) > 1000, "PDF has real content");
  assert.ok((result.pageCount ?? 0) >= 1);

  await rm(texPath).catch(() => {});
  await rm(pdfPath).catch(() => {});
}, { timeout: 90_000 });

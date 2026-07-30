import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { config, PROJECT_ROOT } from "../src/config.js";
import { loadMasterCv, renderApplicationSet, resolveTemplate } from "../src/core/pipeline.js";
import { masterToTailored } from "../src/core/tailoring.js";
import { removeApplication } from "../src/core/tracker.js";

test("package ships only the shared resume and cover-letter templates", async () => {
  const manifest = JSON.parse(await readFile(join(PROJECT_ROOT, "package.json"), "utf-8")) as { files: string[] };

  assert.deepEqual(manifest.files, [
    "dist",
    "templates/AUTHORING.md",
    "templates/cover-letter-template.tex",
    "templates/resume-template.tex",
  ]);
  assert.ok(existsSync(join(config.templatesDir, "cover-letter-template.tex")));
  assert.equal(existsSync(join(config.templatesDir, "cv-template.tex")), false);
});

test("asking for a CV without a personal cv.tex refuses instead of falling back", async () => {
  if (existsSync(join(config.templatesDir, "cv.tex"))) return; // user supplied one
  await assert.rejects(() => resolveTemplate({ template: "cv" }), /No cv template found/);
});

test("a missing CV template does not discard the résumé or cover letter", async () => {
  if (existsSync(join(config.templatesDir, "cv.tex"))) return; // user supplied one
  const cv = await loadMasterCv();
  const full = masterToTailored(cv);
  const content = {
    ...full,
    experience: full.experience.slice(0, 2).map((e) => ({ ...e, bullets: e.bullets.slice(0, 3) })),
    projects: full.projects.slice(0, 2).map((p) => ({ ...p, bullets: p.bullets.slice(0, 2) })),
    skills: full.skills.slice(0, 3),
  };
  const base = join(config.outputDir, "CvFallbackTest_Engineer");
  try {
    const set = await renderApplicationSet({
      content,
      company: "CvFallbackTest",
      position: "Engineer",
      alsoCv: true, // no cv.tex exists — must degrade, not throw
      coverLetter: { company: "CvFallbackTest", position: "Engineer", paragraphs: ["One.", "Two.", "Three."] },
    });

    assert.equal(set.resume.ok, true, set.resume.error);
    assert.equal(set.coverLetter?.ok, true, "cover letter still produced");
    assert.equal(set.cv?.ok, false, "CV reported as failed");
    assert.match(set.cv?.error ?? "", /No cv template found/);
    assert.match(set.cv?.error ?? "", /templates\/cv\.tex/, "error tells the user how to fix it");
    assert.ok(set.tracked, "application still logged");
  } finally {
    for (const p of [`${base}.pdf`, `${base}.tex`, `${base}_CoverLetter.pdf`, `${base}_CoverLetter.tex`]) {
      await rm(p).catch(() => {});
    }
    await removeApplication(config.trackerPath, "CvFallbackTest").catch(() => {});
  }
}, { timeout: 120_000 });

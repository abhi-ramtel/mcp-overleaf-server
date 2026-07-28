import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runCoverLetterPipeline } from "../src/core/coverLetter.js";
import { checkCoverLetterClaims, CoverLetterContentSchema } from "../src/core/schema.js";
import { config } from "../src/config.js";

const CONTENT = {
  company: "Acme AI",
  position: "Backend Engineer",
  paragraphs: [
    "I am writing to apply for the Backend Engineer role at Acme AI. As a founding engineer I built a payments platform in Go from scratch, which maps closely to the infrastructure work described in your posting.",
    "At Cytocybernetics I optimized high-volume data pipelines with vectorized Pandas and NumPy operations, and engineered a parallel C++ processing engine for real-time analysis.",
    "I would welcome the chance to discuss how that experience translates to your team.",
  ],
};

test("checkCoverLetterClaims flags a figure absent from the master CV", () => {
  const master = "Increased throughput by 60% and supported 2,000+ users.";
  const parsed = CoverLetterContentSchema.parse({
    ...CONTENT,
    paragraphs: [
      "I improved throughput by 60% in my last role.",
      "I have 15 years of professional experience building systems.",
    ],
  });
  const report = checkCoverLetterClaims(master, parsed);
  assert.ok(report.warnings.some((w) => w.includes("15")), "flags the invented 15 years");
  assert.ok(!report.warnings.some((w) => w.includes("60%")), "does not flag a real figure");
});

test("checkCoverLetterClaims ignores numbers coming from the company/role", () => {
  const parsed = CoverLetterContentSchema.parse({
    company: "Series 8 Labs",
    position: "Engineer 2",
    paragraphs: ["I am applying to Series 8 Labs for the Engineer 2 position.", "I would be glad to talk."],
  });
  const report = checkCoverLetterClaims("no numbers here", parsed);
  assert.equal(report.warnings.length, 0);
});

test("schema rejects a letter with too few paragraphs", () => {
  const r = CoverLetterContentSchema.safeParse({ company: "X", position: "Y", paragraphs: ["only one"] });
  assert.equal(r.success, false);
});

test("renders and compiles a real one-page cover letter PDF", async () => {
  const outputName = `test_cover_letter_${process.pid}`;
  const tex = join(config.outputDir, `${outputName}.tex`);
  const pdf = join(config.outputDir, `${outputName}.pdf`);
  try {
    const r = await runCoverLetterPipeline({ content: CONTENT, outputName });
    assert.equal(r.ok, true, r.error);
    assert.ok(existsSync(pdf), "PDF written");
    assert.equal(r.pageCount, 1, "cover letter fits on one page");
    assert.ok((r.sizeKB ?? 0) > 1);
  } finally {
    await rm(tex).catch(() => {});
    await rm(pdf).catch(() => {});
  }
}, { timeout: 90_000 });

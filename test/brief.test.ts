import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCv } from "../src/core/cvParser.js";
import { buildTailoringBrief, quantifiedBulletIds } from "../src/core/brief.js";

const CV = `# Test Person

\`you@example.com\`

## Summary

Engineer.

## Experience

**Software Engineer** - Acme, Buffalo, NY
Jan 2024 - May 2025
- Cut application runtime by 60% by restructuring the workload around POSIX threads.
- Engineered a multi-threaded C++/OpenMP engine for real-time analysis of over one million datasets.
- Built GUIs in C with GTK.

**Tech Consultant** - Uni IT, Buffalo, NY
Aug 2023 - Jun 2026
- Provided Tier 2 support to 2,000+ users.
- Imaged Windows Server 2022 machines for CSE 365 labs.

## Projects

**Proxy** - Python
Feb 2026
- Cut context sent from 2,400 to 340 tokens by the fifth exchange.
- Reached sub-100ms latency on the edge path.
- Used AES-256-GCM and HMAC-SHA256 with Gemini 2.0 Flash.

## Education

**Uni**
B.S. in CS
May 2026

## Skills

**Languages:** Python, C/C++
`;

test("quantifiedBulletIds keeps measurable outcomes and ignores bare numbers", () => {
  const cv = parseCv(CV);
  const ids = quantifiedBulletIds(cv);
  const textOf = (id: string) =>
    [...cv.experience, ...cv.projects].flatMap((e) => e.bullets).find((b) => b.id === id)!.text;

  const picked = ids.map(textOf);
  assert.ok(picked.some((t) => t.includes("60%")), "percentage");
  assert.ok(picked.some((t) => t.includes("one million")), "magnitude word");
  assert.ok(picked.some((t) => t.includes("2,000+")), "N+ count");
  assert.ok(picked.some((t) => t.includes("2,400 to 340")), "before → after range");
  assert.ok(picked.some((t) => t.includes("sub-100ms")), "time unit");

  assert.ok(!picked.some((t) => t.includes("GTK")), "no number at all");
  assert.ok(!picked.some((t) => t.includes("Windows Server 2022")), "years and course codes are not metrics");
  assert.ok(!picked.some((t) => t.includes("AES-256-GCM")), "algorithm names and versions are not metrics");
  assert.equal(ids.length, 5);
});

test("the brief asks for one theme and measurable impact, and lists quantified bullets", () => {
  const cv = parseCv(CV);
  const brief = buildTailoringBrief(cv, {
    jobDescription: "Low-latency C++ systems engineer. Performance, concurrency, memory optimization.",
    masterCvText: CV,
    company: "Acme",
    position: "Systems Engineer",
  });

  assert.match(brief, /## Positioning — anchor the whole résumé on ONE theme/);
  assert.match(brief, /Name the theme in one line of your reply/);
  assert.match(brief, /it never shrinks the\s+baseline/);
  assert.match(brief, /## Measurable, system-level impact/);
  assert.match(brief, /Do NOT invent a\s+number/);

  const section = brief.split("## Quantified source bullets")[1]!.split("\n## ")[0]!;
  for (const id of quantifiedBulletIds(cv)) assert.ok(section.includes(id), `lists ${id}`);
  assert.match(brief, /name the theme you anchored on/);
});

test("the brief says so when no bullet carries a metric", () => {
  const plain = CV.replace(/^- .*(?:\d|million).*$/gm, "- Built a thing.");
  const cv = parseCv(plain);
  assert.deepEqual(quantifiedBulletIds(cv), []);
  const brief = buildTailoringBrief(cv, { jobDescription: "Backend engineer.", masterCvText: plain });
  assert.match(brief, /## Quantified source bullets[^\n]*\n\n\(none: no source bullet carries a measurable outcome/);
});

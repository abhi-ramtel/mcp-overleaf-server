import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCv } from "../src/core/cvParser.js";
import { measureDensity } from "../src/core/pipeline.js";
import { masterToTailored } from "../src/core/tailoring.js";

const entries = (kind: "Role" | "Project", count: number): string =>
  Array.from(
    { length: count },
    (_, index) => `**${kind} ${index + 1}** - ${kind === "Role" ? `Company ${index + 1}` : "TypeScript, Node.js"}
Jan 202${index} - Present
- Delivered substantial, sourced outcome ${index + 1}a.
- Built substantial, sourced system ${index + 1}b.
- Improved substantial, sourced workflow ${index + 1}c.`,
  ).join("\n\n");

const master = parseCv(`# Candidate

## Summary

Software engineer.

## Experience

${entries("Role", 4)}

## Projects

${entries("Project", 3)}
`);

test("density flags the 3-role, 2-project cut that visibly under-fills a page", () => {
  const full = masterToTailored(master);
  const sparse = {
    ...full,
    experience: full.experience.slice(0, 3).map((entry) => ({ ...entry, bullets: entry.bullets.slice(0, 3) })),
    projects: full.projects.slice(0, 2).map((entry) => ({ ...entry, bullets: entry.bullets.slice(0, 3) })),
  };

  const density = measureDensity(sparse, master);

  assert.equal(density.totalBullets, 15);
  assert.equal(density.targetExperienceEntries, 4);
  assert.equal(density.targetProjectEntries, 3);
  assert.equal(density.targetTotalBullets, 21);
  assert.equal(density.underFilled, true);
  assert.ok(density.thinEntries.some((entry) => entry.includes("3/4 role entries")));
  assert.ok(density.thinEntries.some((entry) => entry.includes("2/3 project entries")));
});

test("density accepts the full 4-role, 3-project baseline", () => {
  const density = measureDensity(masterToTailored(master), master);

  assert.equal(density.totalBullets, 21);
  assert.equal(density.targetTotalBullets, 21);
  assert.equal(density.underFilled, false);
  assert.deepEqual(density.thinEntries, []);
});

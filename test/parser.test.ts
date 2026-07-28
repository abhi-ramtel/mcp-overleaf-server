import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCv, parseCvFile } from "../src/core/cvParser.js";
import { checkProvenance, TailoredContentSchema } from "../src/core/schema.js";
import { config } from "../src/config.js";

const SAMPLE = `# Jane Doe

\`+1 555-123-4567\` | \`jane@example.com\` | [LinkedIn](https://linkedin.com/in/jane) | [GitHub](https://github.com/jane)

## Summary

Backend engineer with a focus on distributed systems.

## Experience

**Senior Engineer - Platform** - Acme Corp, San Francisco, CA
Jan 2022 - Present
- Cut p99 latency by 40% by rewriting the router in Go.
- Built a multi-region replication layer that wraps
  across two lines in the source file.

## Projects

**Widget** - Rust, WASM
Mar 2023
- Shipped a WASM widget used by 1000 developers.

## Education

**MIT**
B.S. in Computer Science
May 2021

Coursework: Algorithms, Operating Systems

Honors & Activities: Dean's List

## Skills

**Languages:** Go, Rust, Python
**Backend & APIs** gRPC, REST, Kafka
`;

test("parses header, contact, and sections from a sample CV", () => {
  const cv = parseCv(SAMPLE);
  assert.equal(cv.contact.name, "Jane Doe");
  assert.equal(cv.contact.phone, "+1 555-123-4567");
  assert.equal(cv.contact.email, "jane@example.com");
  assert.deepEqual(cv.contact.links.map((l) => l.label), ["LinkedIn", "GitHub"]);
  assert.equal(cv.experience.length, 1);
  assert.equal(cv.projects.length, 1);
  assert.equal(cv.education.length, 1);
  assert.equal(cv.skills.length, 2);
});

test("keeps a bold title that contains its own ' - '", () => {
  const cv = parseCv(SAMPLE);
  assert.equal(cv.experience[0]!.title, "Senior Engineer - Platform");
  assert.equal(cv.experience[0]!.organization, "Acme Corp");
  assert.equal(cv.experience[0]!.location, "San Francisco, CA");
});

test("joins wrapped continuation lines into one bullet", () => {
  const cv = parseCv(SAMPLE);
  const wrapped = cv.experience[0]!.bullets[1]!;
  assert.match(wrapped.text, /replication layer that wraps across two lines/);
  assert.ok(!wrapped.text.includes("\n"));
});

test("parses the skills line that omits the colon", () => {
  const cv = parseCv(SAMPLE);
  const backend = cv.skills.find((s) => s.category === "Backend & APIs");
  assert.ok(backend, "Backend & APIs category present");
  assert.deepEqual(backend!.items, ["gRPC", "REST", "Kafka"]);
});

test("assigns stable ids indexed for provenance", () => {
  const cv = parseCv(SAMPLE);
  assert.equal(cv.experience[0]!.id, "EXP1");
  assert.equal(cv.experience[0]!.bullets[0]!.id, "EXP1.1");
  assert.ok("EXP1.1" in cv.sourceIndex);
  assert.ok("PRJ1.1" in cv.sourceIndex);
});

test("provenance passes when every id is real and no metric is invented", () => {
  const cv = parseCv(SAMPLE);
  const content = TailoredContentSchema.parse({
    summary: "Backend engineer focused on distributed systems.",
    experience: [
      {
        sourceId: "EXP1",
        title: "Senior Engineer",
        organization: "Acme Corp",
        dates: "Jan 2022 - Present",
        bullets: [{ text: "Reduced p99 latency 40% by rewriting the router in Go.", sourceId: "EXP1.1" }],
      },
    ],
    skills: [{ category: "Languages", items: ["Go", "Rust"] }],
  });
  const report = checkProvenance(cv, content);
  assert.equal(report.ok, true, report.errors.join("; "));
  assert.equal(report.warnings.length, 0);
});

test("provenance hard-fails an unknown sourceId", () => {
  const cv = parseCv(SAMPLE);
  const content = TailoredContentSchema.parse({
    summary: "x",
    experience: [
      {
        sourceId: "EXP9",
        title: "Fake",
        organization: "Nowhere",
        dates: "2020",
        bullets: [{ text: "Did a thing.", sourceId: "EXP9.1" }],
      },
    ],
  });
  const report = checkProvenance(cv, content);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => e.includes("EXP9")));
});

test("provenance warns on a fabricated metric and an invented skill", () => {
  const cv = parseCv(SAMPLE);
  const content = TailoredContentSchema.parse({
    summary: "x",
    experience: [
      {
        sourceId: "EXP1",
        title: "Senior Engineer",
        organization: "Acme Corp",
        dates: "Jan 2022 - Present",
        bullets: [{ text: "Cut latency by 95% across 12 regions.", sourceId: "EXP1.1" }],
      },
    ],
    skills: [{ category: "Languages", items: ["Go", "Haskell"] }],
  });
  const report = checkProvenance(cv, content);
  assert.equal(report.ok, true, "warnings are not hard errors");
  assert.ok(report.warnings.some((w) => w.includes("95%")), "flags new metric 95%");
  assert.ok(report.warnings.some((w) => w.includes("12")), "flags new metric 12");
  assert.ok(report.warnings.some((w) => w.toLowerCase().includes("haskell")), "flags invented skill");
});

test("extracts a project URL written as a markdown link heading", () => {
  const cv = parseCv(`# X

## Projects

**[CarbonProxy](https://devpost.com/software/carbonproxy)** - Python, FastAPI
Feb 2026
- Did a thing.

**Unlinked Project** - Rust
Jan 2026
- Did another thing.
`);
  assert.equal(cv.projects.length, 2);
  assert.equal(cv.projects[0]!.name, "CarbonProxy", "link text becomes the name");
  assert.equal(cv.projects[0]!.url, "https://devpost.com/software/carbonproxy");
  assert.equal(cv.projects[0]!.stack, "Python, FastAPI", "stack still parsed");
  assert.equal(cv.projects[1]!.name, "Unlinked Project");
  assert.equal(cv.projects[1]!.url, undefined, "plain heading has no url");
});

test("parses the real cv.md end to end", async () => {
  const cv = await parseCvFile(config.cvMasterPath);
  assert.ok(cv.experience.length >= 3);
  assert.ok(cv.projects.length >= 5);
  assert.ok(Object.keys(cv.sourceIndex).length > 20);
});

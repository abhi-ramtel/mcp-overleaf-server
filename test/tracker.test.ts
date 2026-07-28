import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordApplication, listApplications, parseCsv } from "../src/core/tracker.js";

function tmpTracker(): string {
  return join(tmpdir(), `mcp-tracker-test-${process.pid}-${Math.random().toString(36).slice(2)}.csv`);
}

test("creates the sheet with a header and one row", async () => {
  const path = tmpTracker();
  try {
    const res = await recordApplication(path, {
      company: "OpenAI",
      position: "Member of Technical Staff",
      jobLink: "https://openai.com/careers/123",
      atsScore: 82,
      resumeFile: "OpenAI_Member_of_Technical_Staff.pdf",
      jdSummary: "Build, scale, and, quote-heavy \"LLM\" systems",
      status: "generated",
    });
    assert.equal(res.created, true);
    assert.equal(res.total, 1);

    const raw = await readFile(path, "utf-8");
    assert.match(raw.split("\n")[0]!, /^Date Applied,Company,Position/);

    const rows = await listApplications(path);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.company, "OpenAI");
    assert.equal(rows[0]!.atsScore, "82");
    // Comma + quotes in the JD summary survive a round-trip.
    assert.equal(rows[0]!.jdSummary, 'Build, scale, and, quote-heavy "LLM" systems');
  } finally {
    await rm(path).catch(() => {});
  }
});

test("upserts on company+position instead of duplicating", async () => {
  const path = tmpTracker();
  try {
    await recordApplication(path, { company: "Stripe", position: "Backend Engineer", atsScore: 70, dateApplied: "2026-01-01" });
    const second = await recordApplication(path, {
      company: "stripe",
      position: "backend engineer",
      atsScore: 88,
      status: "applied",
    });
    assert.equal(second.created, false);
    assert.equal(second.total, 1);

    const rows = await listApplications(path);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.atsScore, "88", "score updated");
    assert.equal(rows[0]!.status, "applied", "status updated");
    assert.equal(rows[0]!.dateApplied, "2026-01-01", "original applied date preserved");
  } finally {
    await rm(path).catch(() => {});
  }
});

test("parseCsv handles quoted fields with embedded newlines", () => {
  const rows = parseCsv('a,b\n"line1\nline2","x,y"\n');
  assert.deepEqual(rows[0], ["a", "b"]);
  assert.deepEqual(rows[1], ["line1\nline2", "x,y"]);
});

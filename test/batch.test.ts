import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { planBatch, similarity, roleSimilarity, runBatch, clearCache, MAX_BATCH_JOBS } from "../src/core/batch.js";
import { loadMasterCv } from "../src/core/pipeline.js";
import { masterToTailored } from "../src/core/tailoring.js";
import { removeApplication } from "../src/core/tracker.js";
import { config } from "../src/config.js";

/** Tests share the real tracker; remove anything they wrote. */
async function untrack(...companies: [string, string][]): Promise<void> {
  for (const [c, p] of companies) await removeApplication(config.trackerPath, c, p).catch(() => {});
}

const BACKEND_A = "Backend Engineer. Build distributed systems in Go with PostgreSQL, gRPC, microservices, Kubernetes, and event-driven architecture. Own reliability and scaling.";
const BACKEND_B = "Backend Engineer role: Go services, PostgreSQL, gRPC, microservices, Kubernetes, distributed systems, event-driven architecture, reliability and scaling ownership.";
const FRONTEND = "Frontend Engineer. Build polished React and Next.js interfaces with TypeScript, Tailwind, accessibility, design systems, and animation. Work closely with designers on UI.";

test("similarity is high for like roles and low for unlike ones", () => {
  assert.equal(similarity(["go", "postgres"], ["go", "postgres"]), 1);
  assert.equal(similarity(["go"], ["react"]), 0);
  assert.ok(similarity(["go", "postgres", "grpc"], ["go", "postgres", "react"]) < 0.6);
});

test("roleSimilarity ignores company-specific noise but needs real overlap", () => {
  const core = ["go", "postgres", "grpc", "kubernetes", "microservices", "distributed"];
  // Same role, each posting carrying its own domain nouns.
  const a = [...core, "robotics", "fleets", "autonomy"];
  const b = [...core, "vehicle", "autonomous", "infrastructure"];
  assert.ok(roleSimilarity(a, b) >= 0.6, `expected clustering, got ${roleSimilarity(a, b)}`);
  assert.ok(similarity(a, b) < 0.6, "plain Jaccard would have missed this");

  // A short posting must not be trivially "contained" in a long one.
  const tiny = ["go", "postgres"];
  const long = [...core, "react", "next.js", "typescript", "figma", "css", "animation"];
  assert.ok(roleSimilarity(tiny, long) < 0.6, "too few shared keywords to cluster");

  // Genuinely different roles stay apart.
  const frontend = ["react", "typescript", "next.js", "css", "accessibility", "animation", "design"];
  assert.ok(roleSimilarity(a, frontend) < 0.6);
});

test("planner clusters similar jobs so they share one reasoning pass", async () => {
  await clearCache();
  const plan = await planBatch([
    { company: "Acme", position: "Backend Engineer", jobDescription: BACKEND_A },
    { company: "Globex", position: "Backend Engineer", jobDescription: BACKEND_B },
    { company: "Initech", position: "Frontend Engineer", jobDescription: FRONTEND },
  ]);

  assert.equal(plan.totalJobs, 3);
  assert.equal(plan.jobs[0]!.action, "generate");
  assert.equal(plan.jobs[1]!.action, "reuse-batch", "near-identical backend JD reuses job 0");
  assert.equal(plan.jobs[1]!.reuseFrom, 0);
  assert.equal(plan.jobs[2]!.action, "generate", "frontend role is distinct");
  assert.deepEqual(plan.needsGeneration, [0, 2]);
  assert.equal(plan.reasoningPasses, 2);
  assert.equal(plan.passesSaved, 1);
});

test("planner rejects more than the max batch size", async () => {
  const many = Array.from({ length: MAX_BATCH_JOBS + 1 }, (_, i) => ({
    company: `C${i}`,
    position: "Engineer",
    jobDescription: BACKEND_A,
  }));
  await assert.rejects(() => planBatch(many), /maximum per batch is 10/i);
});

test("batch renders, reuses content, and auto-logs every job", async () => {
  await clearCache();
  const cv = await loadMasterCv();
  const full = masterToTailored(cv);
  const content = {
    ...full,
    experience: full.experience.slice(0, 2),
    projects: full.projects.slice(0, 2),
    skills: full.skills.slice(0, 3),
  };

  const files = ["Acme_Backend_Engineer", "Globex_Backend_Engineer"];
  try {
    const r = await runBatch([
      { company: "Acme", position: "Backend Engineer", jobDescription: BACKEND_A, content },
      { company: "Globex", position: "Backend Engineer", jobDescription: BACKEND_B, reuseFrom: 0 },
    ]);

    assert.equal(r.succeeded, 2, JSON.stringify(r.results.map((x) => x.error)));
    assert.equal(r.generated, 1);
    assert.equal(r.reused, 1);
    for (const res of r.results) {
      assert.ok(res.ok, res.error);
      assert.ok(res.tracked, "job was auto-logged to the tracker");
      assert.ok(res.pdfPath && existsSync(res.pdfPath), "PDF produced");
    }
  } finally {
    for (const f of files) {
      await rm(join(config.outputDir, `${f}.pdf`)).catch(() => {});
      await rm(join(config.outputDir, `${f}.tex`)).catch(() => {});
    }
    await clearCache();
    await untrack(["Acme", "Backend Engineer"], ["Globex", "Backend Engineer"], ["Umbrella", "Backend Engineer"]);
  }
}, { timeout: 120_000 });

test("a cached role is reused in a later batch with no reasoning pass", async () => {
  await clearCache();
  const cv = await loadMasterCv();
  const full = masterToTailored(cv);
  const content = { ...full, experience: full.experience.slice(0, 1), projects: full.projects.slice(0, 1), skills: full.skills.slice(0, 2) };
  const clean = ["Acme_Backend_Engineer", "Umbrella_Backend_Engineer"];
  try {
    // First batch populates the cache.
    await runBatch([{ company: "Acme", position: "Backend Engineer", jobDescription: BACKEND_A, content }]);
    // A later, separate batch with a similar JD should plan as a cache reuse.
    const plan = await planBatch([{ company: "Umbrella", position: "Backend Engineer", jobDescription: BACKEND_B }]);
    assert.equal(plan.jobs[0]!.action, "reuse-cache");
    assert.equal(plan.reasoningPasses, 0, "no model work needed at all");
  } finally {
    for (const f of clean) {
      await rm(join(config.outputDir, `${f}.pdf`)).catch(() => {});
      await rm(join(config.outputDir, `${f}.tex`)).catch(() => {});
    }
    await clearCache();
    await untrack(["Acme", "Backend Engineer"], ["Globex", "Backend Engineer"], ["Umbrella", "Backend Engineer"]);
  }
}, { timeout: 120_000 });

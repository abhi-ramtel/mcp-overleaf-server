import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  planBatch,
  similarity,
  roleSimilarity,
  runBatch,
  clearCache,
  jobKey,
  MAX_BATCH_JOBS,
  MAX_PLAN_JOBS,
  DEFAULT_CHUNK_SIZE,
} from "../src/core/batch.js";
import { loadMasterCv } from "../src/core/pipeline.js";
import { masterToTailored } from "../src/core/tailoring.js";
import { recordApplication, removeApplication } from "../src/core/tracker.js";
import { config } from "../src/config.js";

/** Tests share the real tracker; remove anything they wrote. */
async function untrack(...companies: [string, string][]): Promise<void> {
  for (const [c, p] of companies) await removeApplication(config.trackerPath, c, p).catch(() => {});
}

/** Pretend an application was already generated: a tracker row + its PDF on disk. */
async function pretendDone(company: string, position: string): Promise<string> {
  const file = `${company}_${position.replace(/\s+/g, "_")}.pdf`;
  await mkdir(config.outputDir, { recursive: true });
  await writeFile(join(config.outputDir, file), "%PDF-1.4 test\n", "utf-8");
  await recordApplication(config.trackerPath, { company, position, resumeFile: file, status: "generated" });
  return file;
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
  await untrack(["Acme", "Backend Engineer"], ["Globex", "Backend Engineer"], ["Initech", "Frontend Engineer"]);
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
  assert.equal(plan.chunks.length, 1, "three jobs fit in one render call");
});

test("planner rejects more jobs than one plan may cover", async () => {
  const many = Array.from({ length: MAX_PLAN_JOBS + 1 }, (_, i) => ({
    company: `C${i}`,
    position: "Engineer",
    jobDescription: BACKEND_A,
  }));
  await assert.rejects(() => planBatch(many), /at most 30/i);
});

test("planner splits the work into chunks and rewrites cross-chunk reuse to a cache key", async () => {
  await clearCache();
  const companies: [string, string][] = [
    ["Acme", "Backend Engineer"],
    ["Initech", "Frontend Engineer"],
    ["Globex", "Backend Engineer"],
    ["Umbrella", "Backend Engineer"],
  ];
  await untrack(...companies);
  const plan = await planBatch(
    companies.map(([company, position], i) => ({
      company,
      position,
      jobDescription: [BACKEND_A, FRONTEND, BACKEND_B, BACKEND_B][i]!,
    })),
  );

  assert.equal(plan.chunkSize, DEFAULT_CHUNK_SIZE);
  assert.deepEqual(plan.chunks.map((c) => c.length), [3, 1], "four jobs render as 3 + 1");
  assert.equal(plan.jobs[2]!.chunk, 1);
  assert.equal(plan.jobs[2]!.reuseFrom, 0, "same-chunk reuse addresses the local index");
  assert.equal(plan.jobs[3]!.chunk, 2);
  assert.equal(plan.jobs[3]!.action, "reuse-batch");
  assert.equal(
    plan.jobs[3]!.reuseFrom,
    jobKey("Acme", "Backend Engineer"),
    "a source in an earlier chunk is addressed by cache key, not by an index the next call doesn't have",
  );
});

test("planner skips jobs already in the tracker unless forced", async () => {
  await clearCache();
  const file = await pretendDone("Skipco", "Backend Engineer");
  try {
    const jobs = [{ company: "Skipco", position: "Backend Engineer", jobDescription: BACKEND_A }];
    const plan = await planBatch(jobs);
    assert.equal(plan.jobs[0]!.action, "skip");
    assert.equal(plan.jobs[0]!.skipReason, "already-applied");
    assert.equal(plan.plannedJobs, 0);
    assert.equal(plan.reasoningPasses, 0, "an already-applied job costs nothing");
    assert.equal(plan.chunks.length, 0, "nothing to render");

    const forced = await planBatch(jobs, { force: true });
    assert.equal(forced.jobs[0]!.action, "generate", "force:true rebuilds it");

    // A row whose PDF is gone is unfinished work, not a completed application.
    await rm(join(config.outputDir, file));
    const rebuilt = await planBatch(jobs);
    assert.equal(rebuilt.jobs[0]!.action, "generate");
  } finally {
    await rm(join(config.outputDir, file)).catch(() => {});
    await untrack(["Skipco", "Backend Engineer"]);
  }
});

test("planner skips unusable entries instead of failing the whole batch", async () => {
  await clearCache();
  await untrack(["Acme", "Backend Engineer"], ["Globex", "Backend Engineer"]);
  const plan = await planBatch([
    { company: "Acme", position: "Backend Engineer", jobDescription: BACKEND_A },
    { company: "Acme", position: "Backend Engineer", jobDescription: BACKEND_B },
    { company: "", position: "Backend Engineer", jobDescription: BACKEND_A },
    { company: "Globex", position: "Backend Engineer", jobDescription: "See the link." },
  ]);

  assert.equal(plan.jobs[0]!.action, "generate");
  assert.equal(plan.jobs[1]!.skipReason, "duplicate-in-batch");
  assert.equal(plan.jobs[2]!.skipReason, "missing-fields");
  assert.equal(plan.jobs[3]!.skipReason, "short-description");
  assert.equal(plan.plannedJobs, 1, "one good job still runs");
  assert.equal(plan.skipped.length, 3);
});

test("a chunk larger than the per-call maximum is refused with a usable message", async () => {
  const many = Array.from({ length: MAX_BATCH_JOBS + 1 }, (_, i) => ({
    company: `C${i}`,
    position: "Engineer",
  }));
  await assert.rejects(() => runBatch(many), /at most 10/i);
});

test("renderer skips an already-tracked job without touching LaTeX", async () => {
  const file = await pretendDone("Skipco", "Backend Engineer");
  try {
    // No content and no reuseFrom: if the skip did not happen first this would error.
    const r = await runBatch([{ company: "Skipco", position: "Backend Engineer" }]);
    assert.equal(r.skipped, 1);
    assert.equal(r.failed, 0);
    assert.ok(r.results[0]!.ok);
    assert.match(r.results[0]!.note ?? "", /already generated/i);
  } finally {
    await rm(join(config.outputDir, file)).catch(() => {});
    await untrack(["Skipco", "Backend Engineer"]);
  }
});

test("a duplicate inside one call is skipped rather than overwriting the first", async () => {
  await clearCache();
  const cv = await loadMasterCv();
  const full = masterToTailored(cv);
  const content = { ...full, experience: full.experience.slice(0, 1), projects: full.projects.slice(0, 1), skills: full.skills.slice(0, 2) };
  try {
    const r = await runBatch([
      { company: "Acme", position: "Backend Engineer", jobDescription: BACKEND_A, content },
      { company: "acme", position: "backend engineer", jobDescription: BACKEND_B, content },
    ]);
    assert.equal(r.succeeded, 1);
    assert.equal(r.skipped, 1);
    assert.match(r.results[1]!.note ?? "", /duplicate/i);
  } finally {
    await rm(join(config.outputDir, "Acme_Backend_Engineer.pdf")).catch(() => {});
    await rm(join(config.outputDir, "Acme_Backend_Engineer.tex")).catch(() => {});
    await clearCache();
    await untrack(["Acme", "Backend Engineer"]);
  }
}, { timeout: 120_000 });

test("reuseFrom resolves forward references and chains", async () => {
  await clearCache();
  const cv = await loadMasterCv();
  const full = masterToTailored(cv);
  const content = { ...full, experience: full.experience.slice(0, 1), projects: full.projects.slice(0, 1), skills: full.skills.slice(0, 2) };
  const files = ["Globex_Backend_Engineer", "Umbrella_Backend_Engineer", "Acme_Backend_Engineer"];
  await untrack(["Acme", "Backend Engineer"], ["Globex", "Backend Engineer"], ["Umbrella", "Backend Engineer"]);
  try {
    const r = await runBatch([
      // #0 points forward at #2, and #1 chains through #0 — both must resolve.
      { company: "Globex", position: "Backend Engineer", jobDescription: BACKEND_B, reuseFrom: 2 },
      { company: "Umbrella", position: "Backend Engineer", jobDescription: BACKEND_B, reuseFrom: 0 },
      { company: "Acme", position: "Backend Engineer", jobDescription: BACKEND_A, content },
    ]);
    assert.equal(r.succeeded, 3, JSON.stringify(r.results.map((x) => x.error)));
    assert.equal(r.reused, 2);
  } finally {
    for (const f of files) {
      await rm(join(config.outputDir, `${f}.pdf`)).catch(() => {});
      await rm(join(config.outputDir, `${f}.tex`)).catch(() => {});
    }
    await clearCache();
    await untrack(["Acme", "Backend Engineer"], ["Globex", "Backend Engineer"], ["Umbrella", "Backend Engineer"]);
  }
}, { timeout: 180_000 });

test("a reuseFrom cycle is reported per job, not thrown", async () => {
  const r = await runBatch([
    { company: "Loopy", position: "Engineer", reuseFrom: 1 },
    { company: "Loopier", position: "Engineer", reuseFrom: 0 },
  ]);
  assert.equal(r.failed, 2);
  assert.match(r.results[0]!.error ?? "", /loops back/i);
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
  // A row left behind by an earlier run would (correctly) be skipped instead of rendered.
  await untrack(["Acme", "Backend Engineer"], ["Globex", "Backend Engineer"]);
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
  await untrack(["Acme", "Backend Engineer"], ["Umbrella", "Backend Engineer"]);
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

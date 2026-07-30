/**
 * Batch tailoring — process up to 10 jobs while minimizing model reasoning.
 *
 * The expensive part of this pipeline is the host model writing TailoredContent
 * JSON; rendering and compiling are free. So the planner does two things to cut
 * token spend:
 *
 *   1. **Cross-session cache.** Tailored content is stored keyed by a
 *      fingerprint of the job description's keywords. A later job that looks
 *      like an earlier one reuses the stored content outright.
 *   2. **In-batch clustering.** Within one batch, jobs are grouped by keyword
 *      similarity, so ten backend roles cost one reasoning pass, not ten.
 *
 * Similarity is deterministic (Jaccard over extracted keywords) — no model call
 * is needed to decide what can be reused.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { extractKeywords } from "./keywords.js";
import type { TailoredContent } from "./schema.js";

/** Hard cap on jobs per batch — keeps one run bounded and reviewable. */
export const MAX_BATCH_JOBS = 10;
/** Default similarity above which two jobs share tailored content. */
export const DEFAULT_REUSE_THRESHOLD = 0.6;
/**
 * Minimum shared keywords before two jobs may be considered the same role.
 * Guards the overlap coefficient's failure mode, where a very short posting is
 * trivially "contained" in a long one and would score 1.0 on a handful of words.
 */
export const MIN_SHARED_KEYWORDS = 6;

export interface CacheEntry {
  /** "company|position", lowercased. */
  key: string;
  fingerprint: string;
  keywords: string[];
  template: string;
  content: TailoredContent;
  createdAt: string;
}

function cachePath(): string {
  return join(config.outputDir, ".tailoring-cache.json");
}

export async function loadCache(): Promise<CacheEntry[]> {
  try {
    const raw = JSON.parse(await readFile(cachePath(), "utf-8"));
    return Array.isArray(raw) ? (raw as CacheEntry[]) : [];
  } catch {
    return [];
  }
}

async function writeCache(entries: CacheEntry[]): Promise<void> {
  await mkdir(config.outputDir, { recursive: true });
  // Keep the cache bounded; newest first.
  await writeFile(cachePath(), JSON.stringify(entries.slice(0, 200), null, 2), "utf-8");
}

export async function clearCache(): Promise<void> {
  await writeCache([]);
}

/** Stable id for a keyword set. */
export function fingerprint(keywords: string[]): string {
  return createHash("sha256").update([...keywords].sort().join("|")).digest("hex").slice(0, 16);
}

/** Jaccard similarity between two keyword sets (0..1). */
export function similarity(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Similarity used for clustering. Plain Jaccard is too strict here: two postings
 * for the same role each carry company-specific noise ("robotics, fleets" vs.
 * "vehicle, autonomous") that dilutes the score even when the technical
 * requirements match almost entirely. The overlap coefficient measures how much
 * of the smaller keyword set is covered by the larger, which is what actually
 * decides whether one tailored résumé serves both — provided enough keywords
 * genuinely overlap.
 */
export function roleSimilarity(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const x of A) if (B.has(x)) shared++;
  if (shared < MIN_SHARED_KEYWORDS) {
    // Too little in common to trust containment — fall back to strict Jaccard.
    return shared / (A.size + B.size - shared);
  }
  return shared / Math.min(A.size, B.size);
}

/** Store tailored content so a future similar job can reuse it. */
export async function rememberTailoring(params: {
  company: string;
  position: string;
  keywords: string[];
  template: string;
  content: TailoredContent;
}): Promise<void> {
  const entries = await loadCache();
  const key = `${params.company}|${params.position}`.toLowerCase();
  const entry: CacheEntry = {
    key,
    fingerprint: fingerprint(params.keywords),
    keywords: params.keywords,
    template: params.template,
    content: params.content,
    createdAt: new Date().toISOString(),
  };
  await writeCache([entry, ...entries.filter((e) => e.key !== key)]);
}

export interface BatchJobInput {
  company: string;
  position: string;
  jobDescription: string;
  jobUrl?: string;
  template?: "resume" | "cv";
  /** Application-portal questions for this job, answered in chat. */
  questions?: string[];
}

export type PlanAction = "generate" | "reuse-cache" | "reuse-batch";

export interface PlannedJob {
  index: number;
  company: string;
  position: string;
  jobUrl?: string;
  template: string;
  keywords: string[];
  questions?: string[];
  action: PlanAction;
  /** Batch index (reuse-batch) or cache key (reuse-cache) supplying the content. */
  reuseFrom?: number | string;
  similarity?: number;
  /** Jobs sharing a clusterId share one reasoning pass. */
  clusterId: number;
}

export interface BatchPlan {
  jobs: PlannedJob[];
  /** Batch indices that actually need the model to write content. */
  needsGeneration: number[];
  totalJobs: number;
  reasoningPasses: number;
  passesSaved: number;
  threshold: number;
  warnings: string[];
}

/**
 * Decide, deterministically, which jobs need fresh reasoning and which can
 * reuse content — from the cache or from an earlier job in the same batch.
 */
export async function planBatch(
  jobs: BatchJobInput[],
  opts: { threshold?: number; useCache?: boolean } = {},
): Promise<BatchPlan> {
  const threshold = opts.threshold ?? DEFAULT_REUSE_THRESHOLD;
  const useCache = opts.useCache !== false;
  const warnings: string[] = [];

  if (jobs.length === 0) throw new Error("No jobs provided.");
  if (jobs.length > MAX_BATCH_JOBS) {
    throw new Error(`Too many jobs: ${jobs.length}. The maximum per batch is ${MAX_BATCH_JOBS}.`);
  }

  const cache = useCache ? await loadCache() : [];
  const planned: PlannedJob[] = [];
  const needsGeneration: number[] = [];
  let nextCluster = 0;

  for (const [index, job] of jobs.entries()) {
    const template = job.template ?? "resume";
    const keywords = extractKeywords(job.jobDescription);
    if (keywords.length === 0) {
      warnings.push(`Job ${index} (${job.company}) produced no keywords — the description may be too short.`);
    }

    // 1. Reuse an earlier job in this same batch (free — no extra pass).
    let best: { idx: number; sim: number } | null = null;
    for (const prior of planned) {
      if (prior.template !== template) continue;
      const sim = roleSimilarity(keywords, prior.keywords);
      if (sim >= threshold && (!best || sim > best.sim)) best = { idx: prior.index, sim };
    }
    if (best) {
      const source = planned.find((p) => p.index === best!.idx)!;
      planned.push({
        index,
        company: job.company,
        position: job.position,
        jobUrl: job.jobUrl,
        template,
        keywords,
        questions: job.questions,
        action: "reuse-batch",
        reuseFrom: source.index,
        similarity: Number(best.sim.toFixed(2)),
        clusterId: source.clusterId,
      });
      continue;
    }

    // 2. Reuse a previous session's cached content.
    let cacheHit: { entry: CacheEntry; sim: number } | null = null;
    for (const entry of cache) {
      if (entry.template !== template) continue;
      const sim = roleSimilarity(keywords, entry.keywords);
      if (sim >= threshold && (!cacheHit || sim > cacheHit.sim)) cacheHit = { entry, sim };
    }
    if (cacheHit) {
      planned.push({
        index,
        company: job.company,
        position: job.position,
        jobUrl: job.jobUrl,
        template,
        keywords,
        questions: job.questions,
        action: "reuse-cache",
        reuseFrom: cacheHit.entry.key,
        similarity: Number(cacheHit.sim.toFixed(2)),
        clusterId: nextCluster++,
      });
      continue;
    }

    // 3. Needs a fresh reasoning pass.
    planned.push({
      index,
      company: job.company,
      position: job.position,
      jobUrl: job.jobUrl,
      template,
      keywords,
      questions: job.questions,
      action: "generate",
      clusterId: nextCluster++,
    });
    needsGeneration.push(index);
  }

  return {
    jobs: planned,
    needsGeneration,
    totalJobs: jobs.length,
    reasoningPasses: needsGeneration.length,
    passesSaved: jobs.length - needsGeneration.length,
    threshold,
    warnings,
  };
}

/** Fetch cached content by key (used by batch_render for reuse-cache jobs). */
export async function contentFromCache(key: string): Promise<TailoredContent | null> {
  const cache = await loadCache();
  return cache.find((e) => e.key === key.toLowerCase())?.content ?? null;
}

export interface BatchRenderItem {
  company: string;
  position: string;
  jobUrl?: string;
  /** Used for ATS scoring and cache keywords. */
  jobDescription?: string;
  template?: "resume" | "cv";
  /** Tailored content — required for jobs the plan marked "generate". */
  content?: TailoredContent;
  /** Batch index or cache key to copy content from (reuse jobs). */
  reuseFrom?: number | string;
  /** Optional role-specific summary override when reusing content. */
  summary?: string;
  headerLine?: string;
  /** Cover letter content — produced alongside the résumé in the same pass. */
  coverLetter?: unknown;
  /** Optional fuller CV content; defaults to the résumé content. */
  cvContent?: unknown;
  /** Generate a CV too, using the user's own CV template (default false). */
  alsoCv?: boolean;
}

export interface BatchJobResult {
  index: number;
  company: string;
  position: string;
  ok: boolean;
  source: "generated" | "reused";
  pdfPath?: string;
  pageCount?: number;
  atsPercent?: number;
  warnings: string[];
  tracked: boolean;
  coverLetterPath?: string;
  cvPath?: string;
  error?: string;
}

export interface BatchRunResult {
  results: BatchJobResult[];
  succeeded: number;
  failed: number;
  generated: number;
  reused: number;
}

/**
 * Render, compile, auto-track, and cache a whole batch in one call — no
 * per-job round trip to the model. Content is resolved from the item itself,
 * from another item in the batch, or from the cross-session cache.
 */
export async function runBatch(items: BatchRenderItem[]): Promise<BatchRunResult> {
  if (items.length === 0) throw new Error("No jobs provided.");
  if (items.length > MAX_BATCH_JOBS) {
    throw new Error(`Too many jobs: ${items.length}. The maximum per batch is ${MAX_BATCH_JOBS}.`);
  }
  // Lazy import avoids a cycle at module-init time.
  const { renderApplicationSet } = await import("./pipeline.js");

  const results: BatchJobResult[] = [];
  const resolved = new Map<number, TailoredContent>();

  for (const [index, item] of items.entries()) {
    const base: BatchJobResult = {
      index,
      company: item.company,
      position: item.position,
      ok: false,
      source: "generated",
      warnings: [],
      tracked: false,
    };

    try {
      let content: TailoredContent | undefined = item.content;
      if (!content && item.reuseFrom !== undefined) {
        base.source = "reused";
        if (typeof item.reuseFrom === "number") {
          content = resolved.get(item.reuseFrom);
          if (!content) throw new Error(`reuseFrom=${item.reuseFrom} has no resolved content (is it earlier in the batch and successful?).`);
        } else {
          const cached = await contentFromCache(item.reuseFrom);
          if (!cached) throw new Error(`No cached content for key "${item.reuseFrom}".`);
          content = cached;
        }
      }
      if (!content) throw new Error("No content supplied and no reuseFrom given.");

      // Allow a role-specific summary when reusing an existing body.
      if (item.summary?.trim()) content = { ...content, summary: item.summary.trim() };

      const template = item.template ?? "resume";
      // An application set: résumé + optional CV + cover letter, logged as one row.
      const set = await renderApplicationSet({
        content,
        cvContent: item.cvContent,
        alsoCv: item.alsoCv,
        coverLetter: item.coverLetter,
        company: item.company,
        position: item.position,
        jobUrl: item.jobUrl,
        jobDescription: item.jobDescription,
        headerLine: item.headerLine,
      });
      const r = set.resume;

      base.ok = r.ok;
      base.pdfPath = r.pdfPath;
      base.pageCount = r.pageCount;
      base.atsPercent = r.ats?.percent;
      base.tracked = Boolean(set.tracked);
      base.cvPath = set.cv?.pdfPath;
      base.coverLetterPath = set.coverLetter?.pdfPath;
      base.warnings = [
        ...r.provenance.warnings,
        ...(r.pageCount && r.pageCount > 1 ? [`${r.pageCount} pages — trim to fit one page.`] : []),
        ...(set.cv && !set.cv.ok ? [`CV failed: ${set.cv.error}`] : []),
        ...(set.coverLetter?.warnings ?? []),
        ...(set.coverLetter && !set.coverLetter.ok ? [`cover letter failed: ${set.coverLetter.error}`] : []),
      ];
      if (!r.ok) base.error = r.error;

      if (r.ok) {
        resolved.set(index, content);
        // Only cache freshly generated content, keyed by this job's own JD.
        if (item.content && item.jobDescription?.trim()) {
          await rememberTailoring({
            company: item.company,
            position: item.position,
            keywords: extractKeywords(item.jobDescription),
            template,
            content,
          });
        }
      }
    } catch (err) {
      base.error = err instanceof Error ? err.message : String(err);
    }
    results.push(base);
  }

  return {
    results,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    generated: results.filter((r) => r.ok && r.source === "generated").length,
    reused: results.filter((r) => r.ok && r.source === "reused").length,
  };
}

/** Human-readable plan summary for the model/user. */
export function formatPlan(plan: BatchPlan): string {
  const lines = [
    `Batch plan — ${plan.totalJobs} job(s), ${plan.reasoningPasses} reasoning pass(es) needed` +
      (plan.passesSaved > 0 ? `, ${plan.passesSaved} saved by reuse.` : "."),
    "",
  ];
  for (const j of plan.jobs) {
    const tag =
      j.action === "generate"
        ? "GENERATE  ← you must write TailoredContent for this one"
        : j.action === "reuse-batch"
          ? `reuse job #${j.reuseFrom} (similarity ${j.similarity})`
          : `reuse cache "${j.reuseFrom}" (similarity ${j.similarity})`;
    lines.push(`  #${j.index}  ${j.company} — ${j.position}  [${j.template}]  →  ${tag}`);
  }
  if (plan.warnings.length) lines.push("", "Warnings:", ...plan.warnings.map((w) => `  • ${w}`));

  const withQuestions = plan.jobs.filter((j) => (j.questions?.length ?? 0) > 0);
  if (withQuestions.length > 0) {
    lines.push("", "Application questions to answer IN CHAT (they do not go in any document):");
    for (const j of withQuestions) {
      lines.push(`  ${j.company} — ${j.position}:`);
      for (const q of j.questions ?? []) lines.push(`    • ${q}`);
    }
    lines.push(
      "  Answer each in first person, 3-6 sentences, grounded only in the master CV, referencing the",
      "  company and role concretely. Group the answers by company in your reply.",
    );
  }

  lines.push(
    "",
    `Write TailoredContent JSON ONLY for indices: [${plan.needsGeneration.join(", ") || "none"}].`,
    "Then call `batch_render` once with every job — supply `content` for generated ones and leave",
    "it out for reuse ones (the server pulls their content automatically). Each job produces a résumé and,",
    "when you pass `coverLetter`, a cover letter — all logged to the tracker automatically.",
  );
  return lines.join("\n");
}

/**
 * Batch tailoring — plan many jobs, then render them a few at a time.
 *
 * The expensive part of this pipeline is the host model writing TailoredContent
 * JSON; rendering and compiling are cheap but slow (a LaTeX run per document).
 * The planner therefore does three things:
 *
 *   1. **Skip what is already done.** A job whose résumé is already in the
 *      tracker (and still on disk) is not re-rendered. Re-running the same list
 *      is a no-op instead of a failure, so a partially finished batch can be
 *      resumed by simply submitting the whole list again.
 *   2. **Reuse content.** Tailored content is cached across sessions keyed by
 *      the job's keywords, and within one batch similar roles are clustered, so
 *      ten backend roles cost one reasoning pass, not ten.
 *   3. **Chunk the work.** The remaining jobs are split into small groups
 *      (default {@link DEFAULT_CHUNK_SIZE}) so each `batch_render` call stays
 *      short. A long call is what times out and takes the server down with it;
 *      several small calls let a batch grow past what one call could carry.
 *
 * Similarity is deterministic (overlap/Jaccard over extracted keywords) — no
 * model call is needed to decide what can be reused.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { extractKeywords } from "./keywords.js";
import { listApplications } from "./tracker.js";
import type { TailoredContent } from "./schema.js";

/** Hard cap on jobs in a single `batch_render` call — keeps one call bounded. */
export const MAX_BATCH_JOBS = 10;
/** Hard cap on jobs one `batch_plan` call may cover, across all its chunks. */
export const MAX_PLAN_JOBS = 30;
/** Jobs per `batch_render` call. Small enough that a call always finishes. */
export const DEFAULT_CHUNK_SIZE = 3;
/** Below this many characters there is nothing to tailor against. */
export const MIN_JD_CHARS = 100;
/** Default similarity above which two jobs share tailored content. */
export const DEFAULT_REUSE_THRESHOLD = 0.6;
/**
 * Minimum shared keywords before two jobs may be considered the same role.
 * Guards the overlap coefficient's failure mode, where a very short posting is
 * trivially "contained" in a long one and would score 1.0 on a handful of words.
 */
export const MIN_SHARED_KEYWORDS = 6;

/** Canonical identity of an application: "company|position", lowercased. */
export function jobKey(company: string, position: string): string {
  return `${company.trim().toLowerCase()}|${position.trim().toLowerCase()}`;
}

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
  const key = jobKey(params.company, params.position);
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

export interface CompletedApplication {
  key: string;
  company: string;
  position: string;
  /** As recorded in the tracker — usually just the filename. */
  resumeFile: string;
  /** Where that file actually is on disk. */
  resumePath: string;
  dateApplied?: string;
  status?: string;
}

/**
 * Applications the tracker already covers — keyed by company+position.
 *
 * A row only counts as done while its résumé PDF is still on disk: if the file
 * was deleted the application is treated as unfinished so it can be rebuilt. A
 * missing or unreadable tracker is not an error; it simply means nothing is
 * done yet, and must never block a run.
 */
export async function completedApplications(): Promise<Map<string, CompletedApplication>> {
  const done = new Map<string, CompletedApplication>();
  let rows;
  try {
    rows = await listApplications(config.trackerPath);
  } catch {
    return done;
  }
  for (const r of rows) {
    const company = (r.company ?? "").trim();
    const position = (r.position ?? "").trim();
    if (!company || !position) continue;
    const resumeFile = (r.resumeFile ?? "").trim();
    if (!resumeFile) continue;
    const inOutputDir = join(config.outputDir, resumeFile);
    const resumePath = existsSync(inOutputDir) ? inOutputDir : existsSync(resumeFile) ? resumeFile : "";
    if (!resumePath) continue;
    done.set(jobKey(company, position), {
      key: jobKey(company, position),
      company,
      position,
      resumeFile,
      resumePath,
      dateApplied: r.dateApplied,
      status: r.status,
    });
  }
  return done;
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

export type PlanAction = "generate" | "reuse-cache" | "reuse-batch" | "skip";

/** Why a planned job needs no work at all. */
export type SkipReason = "already-applied" | "duplicate-in-batch" | "missing-fields" | "short-description";

export interface PlannedJob {
  index: number;
  company: string;
  position: string;
  jobUrl?: string;
  template: string;
  keywords: string[];
  questions?: string[];
  action: PlanAction;
  /** Set when action is "skip". */
  skipReason?: SkipReason;
  /** Human-readable explanation for a skip or a fallback. */
  note?: string;
  /** Local index within the same chunk (reuse-batch) or cache key (reuse-cache
   *  and cross-chunk reuse) supplying the content. */
  reuseFrom?: number | string;
  similarity?: number;
  /** Jobs sharing a clusterId share one reasoning pass. */
  clusterId: number;
  /** 1-based `batch_render` call this job belongs to. Unset for skipped jobs. */
  chunk?: number;
  /** 0-based position inside that call — the index `reuseFrom` refers to. */
  chunkIndex?: number;
}

export interface BatchPlan {
  jobs: PlannedJob[];
  /** Jobs to render, grouped into one group per `batch_render` call. */
  chunks: PlannedJob[][];
  chunkSize: number;
  /** Jobs needing no work, with the reason on each. */
  skipped: PlannedJob[];
  /** Original indices that need the model to write content. */
  needsGeneration: number[];
  totalJobs: number;
  /** Jobs that will actually be rendered (total minus skipped). */
  plannedJobs: number;
  reasoningPasses: number;
  passesSaved: number;
  threshold: number;
  warnings: string[];
}

export interface PlanOptions {
  threshold?: number;
  useCache?: boolean;
  /** Jobs per `batch_render` call (default {@link DEFAULT_CHUNK_SIZE}). */
  chunkSize?: number;
  /** Re-plan jobs already in the tracker instead of skipping them. */
  force?: boolean;
}

/**
 * Decide, deterministically, which jobs are already done, which need fresh
 * reasoning, and which can reuse content — then split the work into chunks
 * small enough that each render call completes comfortably.
 */
export async function planBatch(jobs: BatchJobInput[], opts: PlanOptions = {}): Promise<BatchPlan> {
  const threshold = opts.threshold ?? DEFAULT_REUSE_THRESHOLD;
  const useCache = opts.useCache !== false;
  const chunkSize = Math.max(1, Math.min(opts.chunkSize ?? DEFAULT_CHUNK_SIZE, MAX_BATCH_JOBS));
  const warnings: string[] = [];

  if (jobs.length === 0) throw new Error("No jobs provided.");
  if (jobs.length > MAX_PLAN_JOBS) {
    throw new Error(
      `Too many jobs: ${jobs.length}. One plan covers at most ${MAX_PLAN_JOBS}. ` +
        `Plan the first ${MAX_PLAN_JOBS} now and run a second batch_plan for the rest.`,
    );
  }

  const done = opts.force ? new Map<string, CompletedApplication>() : await completedApplications();
  const cache = useCache ? await loadCache() : [];
  const planned: PlannedJob[] = [];
  const needsGeneration: number[] = [];
  const seen = new Map<string, number>();
  let nextCluster = 0;

  for (const [index, job] of jobs.entries()) {
    const company = (job.company ?? "").trim();
    const position = (job.position ?? "").trim();
    const template = job.template ?? "resume";
    const jd = (job.jobDescription ?? "").trim();
    const keywords = jd ? extractKeywords(jd) : [];
    const common = {
      index,
      company,
      position,
      jobUrl: job.jobUrl,
      template,
      keywords,
      questions: job.questions,
    };

    const skip = (skipReason: SkipReason, note: string): void => {
      planned.push({ ...common, action: "skip", skipReason, note, clusterId: -1 });
    };

    // 0. Unusable or redundant input — skipped, never fatal. One bad entry must
    //    not cost the user the other nine.
    if (!company || !position) {
      skip(
        "missing-fields",
        `missing ${!company ? "company" : ""}${!company && !position ? " and " : ""}${!position ? "position" : ""} — ` +
          "read them off the posting and re-submit this one.",
      );
      continue;
    }
    const key = jobKey(company, position);
    const firstSeen = seen.get(key);
    if (firstSeen !== undefined) {
      skip("duplicate-in-batch", `same company+position as job #${firstSeen} in this list.`);
      continue;
    }
    seen.set(key, index);

    const already = done.get(key);
    if (already) {
      skip(
        "already-applied",
        `already generated${already.dateApplied ? ` on ${already.dateApplied}` : ""} (${already.resumeFile})` +
          `${already.status && already.status !== "generated" ? `, status "${already.status}"` : ""}. ` +
          "Pass force:true to rebuild it.",
      );
      continue;
    }
    if (jd.length < MIN_JD_CHARS) {
      skip(
        "short-description",
        `job description is ${jd.length} chars — paste the full posting (a URL alone does not work).`,
      );
      continue;
    }
    if (keywords.length === 0) {
      warnings.push(`Job #${index} (${company}) produced no keywords — the description may be boilerplate.`);
    }

    // 1. Reuse an earlier job in this same batch (free — no extra pass).
    let best: { idx: number; sim: number } | null = null;
    for (const prior of planned) {
      if (prior.action === "skip" || prior.template !== template) continue;
      const sim = roleSimilarity(keywords, prior.keywords);
      if (sim >= threshold && (!best || sim > best.sim)) best = { idx: prior.index, sim };
    }
    if (best) {
      const source = planned.find((p) => p.index === best!.idx)!;
      planned.push({
        ...common,
        action: "reuse-batch",
        // Rewritten to a local index (or a cache key, when the source lands in
        // an earlier chunk) once chunk boundaries are known.
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
        ...common,
        action: "reuse-cache",
        reuseFrom: cacheHit.entry.key,
        similarity: Number(cacheHit.sim.toFixed(2)),
        clusterId: nextCluster++,
      });
      continue;
    }

    // 3. Needs a fresh reasoning pass.
    planned.push({ ...common, action: "generate", clusterId: nextCluster++ });
    needsGeneration.push(index);
  }

  // 4. Chunk the renderable jobs and rewrite in-batch references. A reuse job
  //    always follows its source, so the source is in this chunk or an earlier
  //    one; a cross-chunk source is addressed by cache key instead, which
  //    resolves because every rendered job is cached under its own key.
  const renderable = planned.filter((j) => j.action !== "skip");
  const chunks: PlannedJob[][] = [];
  for (let i = 0; i < renderable.length; i += chunkSize) {
    const group = renderable.slice(i, i + chunkSize);
    const chunkNo = chunks.length + 1;
    group.forEach((j, localIndex) => {
      j.chunk = chunkNo;
      j.chunkIndex = localIndex;
    });
    chunks.push(group);
  }
  for (const j of renderable) {
    if (j.action !== "reuse-batch" || typeof j.reuseFrom !== "number") continue;
    const source = renderable.find((p) => p.index === j.reuseFrom);
    if (!source) {
      // The source was skipped after all — fall back to a fresh pass.
      j.action = "generate";
      j.note = "its cluster source was skipped, so this one needs its own content.";
      delete j.reuseFrom;
      delete j.similarity;
      needsGeneration.push(j.index);
      continue;
    }
    if (source.chunk === j.chunk) {
      j.reuseFrom = source.chunkIndex!;
    } else {
      j.reuseFrom = jobKey(source.company, source.position);
      j.note = `content comes from ${source.company} — ${source.position} in chunk ${source.chunk}.`;
    }
  }
  needsGeneration.sort((a, b) => a - b);

  const skipped = planned.filter((j) => j.action === "skip");
  if (renderable.length === 0) {
    warnings.push("Nothing to render — every job was skipped. Nothing else to do.");
  }

  return {
    jobs: planned,
    chunks,
    chunkSize,
    skipped,
    needsGeneration,
    totalJobs: jobs.length,
    plannedJobs: renderable.length,
    reasoningPasses: needsGeneration.length,
    passesSaved: renderable.length - needsGeneration.length,
    threshold,
    warnings,
  };
}

/** Fetch cached content by key (used by batch_render for reuse-cache jobs). */
export async function contentFromCache(key: string): Promise<TailoredContent | null> {
  const cache = await loadCache();
  return cache.find((e) => e.key === key.trim().toLowerCase())?.content ?? null;
}

/**
 * Cache lookup for a reuse job. The exact key is tried first; if the entry is
 * gone (cache cleared, or the source render failed) a similar cached role is
 * accepted rather than failing the job outright.
 */
async function resolveFromCache(
  key: string,
  jobDescription?: string,
  threshold = DEFAULT_REUSE_THRESHOLD,
): Promise<{ content: TailoredContent; note?: string } | null> {
  const cache = await loadCache();
  const exact = cache.find((e) => e.key === key.trim().toLowerCase());
  if (exact) return { content: exact.content };

  const jd = jobDescription?.trim();
  if (!jd) return null;
  const keywords = extractKeywords(jd);
  let best: { entry: CacheEntry; sim: number } | null = null;
  for (const entry of cache) {
    const sim = roleSimilarity(keywords, entry.keywords);
    if (sim >= threshold && (!best || sim > best.sim)) best = { entry, sim };
  }
  if (!best) return null;
  return {
    content: best.entry.content,
    note: `cache key "${key}" was gone; reused the similar cached role "${best.entry.key}" (similarity ${best.sim.toFixed(2)}).`,
  };
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
  /** Rebuild this job even if the tracker already has it. */
  force?: boolean;
}

export interface BatchJobResult {
  index: number;
  company: string;
  position: string;
  ok: boolean;
  source: "generated" | "reused" | "skipped";
  /** True when no document was produced because none was needed. */
  skipped?: boolean;
  /** Why it was skipped, or how content was resolved. */
  note?: string;
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
  skipped: number;
  generated: number;
  reused: number;
}

export interface RunBatchOptions {
  /** Rebuild jobs the tracker already has (default false — they are skipped). */
  force?: boolean;
}

/**
 * Render, compile, auto-track, and cache one chunk of a batch in a single call.
 * Content is resolved from the item itself, from another item in the same call,
 * or from the cross-session cache — including content another chunk just
 * produced, since every successful render is cached under its own key.
 *
 * No single job can fail the call: each one is isolated and reported on its own.
 */
export async function runBatch(items: BatchRenderItem[], opts: RunBatchOptions = {}): Promise<BatchRunResult> {
  if (items.length === 0) throw new Error("No jobs provided.");
  if (items.length > MAX_BATCH_JOBS) {
    throw new Error(
      `Too many jobs in one call: ${items.length}. Send at most ${MAX_BATCH_JOBS} ` +
        `(batch_plan chunks at ${DEFAULT_CHUNK_SIZE}) and call this tool once per chunk.`,
    );
  }
  // Lazy import avoids a cycle at module-init time.
  const { renderApplicationSet } = await import("./pipeline.js");

  const done = opts.force ? new Map<string, CompletedApplication>() : await completedApplications();
  const results: BatchJobResult[] = [];
  const rendered = new Set<string>();

  /**
   * Walk a reuseFrom chain to the content behind it. Resolving from the items
   * themselves (rather than from what has rendered so far) means a reference
   * may point forward, and survives the referenced job failing to compile.
   */
  const contentFrom = async (i: number, chain: Set<number>): Promise<TailoredContent> => {
    if (chain.has(i)) throw new Error(`reuseFrom loops back to job #${i} — break the cycle by supplying content.`);
    chain.add(i);
    const it = items[i];
    if (!it) throw new Error(`reuseFrom=${i} is out of range (this call has jobs 0-${items.length - 1}).`);
    if (it.content) return it.content;
    if (typeof it.reuseFrom === "number") return contentFrom(it.reuseFrom, chain);
    if (typeof it.reuseFrom === "string") {
      const hit = await resolveFromCache(it.reuseFrom, it.jobDescription);
      if (hit) return hit.content;
      throw new Error(`No cached content for key "${it.reuseFrom}" (referenced via job #${i}).`);
    }
    throw new Error(`Job #${i} has neither content nor reuseFrom, so job(s) reusing it cannot resolve.`);
  };

  for (const [index, item] of items.entries()) {
    const company = (item.company ?? "").trim();
    const position = (item.position ?? "").trim();
    const base: BatchJobResult = {
      index,
      company,
      position,
      ok: false,
      source: "generated",
      warnings: [],
      tracked: false,
    };

    try {
      if (!company || !position) {
        throw new Error("company and position are both required — they name the output file and tracker row.");
      }
      const key = jobKey(company, position);

      // Already handled, here or in an earlier run — skipping keeps a re-submitted
      // list idempotent instead of overwriting finished work.
      if (rendered.has(key)) {
        results.push({ ...base, ok: true, source: "skipped", skipped: true, note: "duplicate of an earlier job in this call." });
        continue;
      }
      const already = done.get(key);
      if (already && !item.force) {
        results.push({
          ...base,
          ok: true,
          source: "skipped",
          skipped: true,
          note:
            `already generated${already.dateApplied ? ` on ${already.dateApplied}` : ""} (${already.resumeFile}) — ` +
            "pass force:true to rebuild it.",
          pdfPath: already.resumePath,
        });
        continue;
      }

      let content: TailoredContent | undefined = item.content;
      if (!content && item.reuseFrom !== undefined) {
        base.source = "reused";
        if (typeof item.reuseFrom === "number") {
          content = await contentFrom(item.reuseFrom, new Set([index]));
        } else {
          const hit = await resolveFromCache(item.reuseFrom, item.jobDescription);
          if (!hit) {
            throw new Error(
              `No cached content for key "${item.reuseFrom}". Re-run batch_plan (the cache may have been ` +
                "cleared), or supply `content` for this job.",
            );
          }
          content = hit.content;
          if (hit.note) base.note = hit.note;
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
        company,
        position,
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
        rendered.add(key);
        // Cache every rendered job under its own key, generated or reused. That
        // is what lets a later chunk address this job's content by key.
        try {
          await rememberTailoring({
            company,
            position,
            keywords: item.jobDescription?.trim() ? extractKeywords(item.jobDescription) : [],
            template,
            content,
          });
        } catch {
          // A cache write must never fail a document that already compiled.
        }
      }
    } catch (err) {
      base.error = err instanceof Error ? err.message : String(err);
    }
    results.push(base);
  }

  return {
    results,
    succeeded: results.filter((r) => r.ok && !r.skipped).length,
    failed: results.filter((r) => !r.ok).length,
    skipped: results.filter((r) => r.skipped).length,
    generated: results.filter((r) => r.ok && !r.skipped && r.source === "generated").length,
    reused: results.filter((r) => r.ok && !r.skipped && r.source === "reused").length,
  };
}

/** Human-readable plan summary for the model/user. */
export function formatPlan(plan: BatchPlan): string {
  const lines: string[] = [
    `Batch plan — ${plan.totalJobs} job(s): ${plan.plannedJobs} to render in ` +
      `${plan.chunks.length} call(s) of up to ${plan.chunkSize}` +
      `${plan.skipped.length ? `, ${plan.skipped.length} skipped` : ""}. ` +
      `${plan.reasoningPasses} reasoning pass(es) needed` +
      (plan.passesSaved > 0 ? `, ${plan.passesSaved} saved by reuse.` : "."),
  ];

  if (plan.skipped.length) {
    lines.push("", "SKIPPED — no work needed, do not render these:");
    for (const j of plan.skipped) {
      lines.push(`  ⏭  #${j.index}  ${j.company || "(no company)"} — ${j.position || "(no position)"}: ${j.note}`);
    }
  }

  if (plan.chunks.length === 0) {
    lines.push("", "Nothing to render. Report the skipped jobs above and stop — do not call batch_render.");
  } else {
    lines.push(
      "",
      `Call \`batch_render\` ONCE PER CHUNK, in order, waiting for each call to return before starting the next.`,
      "Never merge chunks into one call — that is what times the server out.",
    );
    for (const chunk of plan.chunks) {
      lines.push("", `── Chunk ${chunk[0]!.chunk} of ${plan.chunks.length} — batch_render with these ${chunk.length} job(s):`);
      for (const j of chunk) {
        const tag =
          j.action === "generate"
            ? "GENERATE  ← you must write TailoredContent for this one"
            : j.action === "reuse-batch"
              ? typeof j.reuseFrom === "number"
                ? `reuseFrom: ${j.reuseFrom} (job [${j.reuseFrom}] in this same call, similarity ${j.similarity})`
                : `reuseFrom: "${j.reuseFrom}" (similarity ${j.similarity})`
              : `reuseFrom: "${j.reuseFrom}" (cached role, similarity ${j.similarity})`;
        lines.push(`   [${j.chunkIndex}]  ${j.company} — ${j.position}  [${j.template}]  →  ${tag}`);
        if (j.note) lines.push(`        ↳ ${j.note}`);
      }
    }
  }

  if (plan.warnings.length) lines.push("", "Warnings:", ...plan.warnings.map((w) => `  • ${w}`));

  const withQuestions = plan.jobs.filter((j) => j.action !== "skip" && (j.questions?.length ?? 0) > 0);
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

  if (plan.chunks.length > 0) {
    lines.push(
      "",
      `Write TailoredContent JSON ONLY for the ${plan.reasoningPasses} job(s) marked GENERATE` +
        (plan.needsGeneration.length ? ` (original indices: ${plan.needsGeneration.join(", ")})` : "") +
        ". Leave `content` out of every reuse job — pass its `reuseFrom` exactly as printed and the server",
      "resolves the content itself. Each job produces a résumé and, when you pass `coverLetter`, a cover",
      "letter — all logged to the tracker automatically.",
      "If a chunk reports a failure, fix and re-send just that job; already-rendered jobs are skipped on a re-run.",
    );
  }
  return lines.join("\n");
}

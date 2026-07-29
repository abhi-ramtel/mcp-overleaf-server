/**
 * Compose layer — stitches the core modules into the two operations the MCP
 * tools expose:
 *   • buildTailoringBrief() — everything the host model needs to produce
 *     TailoredContent (master CV with ids, JD keyword signals, rules, schema).
 *   • runRenderPipeline()   — zod-validate → provenance → render → validate →
 *     compile → save, with optional ATS coverage.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { config } from "../config.js";
import { parseCvFile } from "./cvParser.js";
import { TailoredContentSchema, checkProvenance } from "./schema.js";
import type { TailoredContent, ProvenanceReport } from "./schema.js";
import type { MasterCv } from "./types.js";
import { renderTemplate } from "./latexRenderer.js";
import { isNativeDocument, injectIntoDocument } from "./documentInjector.js";
import { validateTex } from "./latexValidate.js";
import type { ValidationResult } from "./latexValidate.js";
import { compileTex } from "./latexCompile.js";
import { extractKeywords, scoreCoverage, keywordGap } from "./keywords.js";
import type { CoverageResult, GapResult } from "./keywords.js";
import { safeResolve } from "./overleafGit.js";
import { recordApplication } from "./tracker.js";

export async function loadMasterCv(): Promise<MasterCv> {
  if (!existsSync(config.cvMasterPath)) {
    throw new Error(`Master CV not found at ${config.cvMasterPath}. Set CV_MASTER_PATH in .env.`);
  }
  return parseCvFile(config.cvMasterPath);
}

export function sanitizeFilePart(s: string): string {
  return s.trim().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** `Company_Position` (sanitized) → the requested output filename base. */
export function outputBaseName(company?: string, position?: string, fallback = "resume"): string {
  const joined = [company, position].filter(Boolean).map((x) => sanitizeFilePart(x!)).filter(Boolean).join("_");
  return joined || fallback;
}

export interface TemplateChoice {
  template?: "resume" | "cv";
  /** Explicit template file — absolute, or relative to the synced repo / templates dir. */
  templateFile?: string;
  repoDir?: string;
}

/** Resolve which template .tex to render into. */
export async function resolveTemplate(choice: TemplateChoice): Promise<{ tex: string; source: string }> {
  if (choice.templateFile) {
    let p: string;
    if (isAbsolute(choice.templateFile)) p = choice.templateFile;
    else if (choice.repoDir) p = safeResolve(choice.repoDir, choice.templateFile);
    else p = resolve(config.templatesDir, choice.templateFile);
    if (!existsSync(p)) throw new Error(`Template file not found: ${choice.templateFile}`);
    return { tex: await readFile(p, "utf-8"), source: p };
  }
  // Resolve by document type, preferring YOUR document over the bundled fallback:
  //   resume → templates/main.tex (your polished résumé) else resume-template.tex
  //   cv     → templates/cv.tex / main-cv.tex          else cv-template.tex
  // RESUME_TEMPLATE / CV_TEMPLATE env vars override the search entirely.
  const type = choice.template ?? "resume";
  const envFile = (type === "cv" ? process.env.CV_TEMPLATE : process.env.RESUME_TEMPLATE)?.trim();
  const candidates = envFile
    ? [envFile]
    : type === "cv"
      ? ["cv.tex", "main-cv.tex", "cv-template.tex"]
      : ["main.tex"];

  for (const name of candidates) {
    const p = isAbsolute(name) ? name : join(config.templatesDir, name);
    if (existsSync(p)) return { tex: await readFile(p, "utf-8"), source: name };
  }
  throw new Error(`No ${type} template found (looked for: ${candidates.join(", ")}).`);
}

/** Crude LaTeX → plain text, good enough for keyword coverage. */
export function latexToText(tex: string): string {
  let t = tex.replace(/(^|[^\\])%.*$/gm, "$1");
  const doc = t.indexOf("\\begin{document}");
  if (doc >= 0) t = t.slice(doc);
  t = t.replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?/g, " "); // drop \commands (+ optional [..])
  t = t.replace(/\$[^$]*\$/g, " "); // drop inline math ($|$, bullets)
  t = t.replace(/[{}~^\\]/g, " ");
  return t.replace(/\s+/g, " ").trim();
}

export interface RenderInput {
  content: unknown;
  template?: "resume" | "cv";
  templateFile?: string;
  repoDir?: string;
  company?: string;
  position?: string;
  outputName?: string;
  headerLine?: string;
  jobDescription?: string;
  compile?: boolean;
  /** Job posting URL — recorded in the tracker. */
  jobUrl?: string;
  /** Short JD summary for the tracker row. */
  jdSummary?: string;
  /** Auto-log to the application tracker (default true when company+position are known). */
  autoTrack?: boolean;
  /** Filenames recorded alongside the résumé in the tracker row. */
  cvFile?: string;
  coverLetterFile?: string;
}

export interface RenderOutput {
  ok: boolean;
  outputBase: string;
  templateSource: string;
  texPath?: string;
  pdfPath?: string;
  pageCount?: number;
  sizeKB?: number;
  provenance: ProvenanceReport;
  validation?: ValidationResult;
  ats?: { percent: number; matched: string[]; missing: string[]; gap: GapResult };
  /** Set when the run was auto-logged to the application tracker. */
  tracked?: { created: boolean; total: number };
  /** Content-density signals — used to flag a page that is under-filled. */
  density?: {
    experienceEntries: number;
    projectEntries: number;
    totalBullets: number;
    /** Entries carrying fewer bullets than the target (3 per role, 2 per project). */
    thinEntries: string[];
    underFilled: boolean;
  };
  error?: string;
}

/** Target bullet counts — a one-page résumé should be full, not half empty. */
const TARGET_BULLETS_PER_ROLE = 3;
const TARGET_BULLETS_PER_PROJECT = 2;
/** Below this many total bullets a single page will visibly under-fill. */
const MIN_TOTAL_BULLETS = 12;

function measureDensity(content: TailoredContent): NonNullable<RenderOutput["density"]> {
  const thinEntries: string[] = [];
  let totalBullets = 0;

  for (const e of content.experience) {
    totalBullets += e.bullets.length;
    if (e.bullets.length < TARGET_BULLETS_PER_ROLE) {
      thinEntries.push(`${e.organization} (${e.bullets.length}/${TARGET_BULLETS_PER_ROLE} bullets)`);
    }
  }
  for (const p of content.projects) {
    totalBullets += p.bullets.length;
    if (p.bullets.length < TARGET_BULLETS_PER_PROJECT) {
      thinEntries.push(`${p.name} (${p.bullets.length}/${TARGET_BULLETS_PER_PROJECT} bullets)`);
    }
  }

  return {
    experienceEntries: content.experience.length,
    projectEntries: content.projects.length,
    totalBullets,
    thinEntries,
    underFilled: totalBullets < MIN_TOTAL_BULLETS || thinEntries.length > 0,
  };
}

/**
 * Full document pipeline. Refuses to compile on a provenance hard-failure or a
 * structural LaTeX error, returning the reasons so the host can correct the JSON.
 */
export async function runRenderPipeline(input: RenderInput): Promise<RenderOutput> {
  const base = input.outputName
    ? sanitizeFilePart(input.outputName) || "resume"
    : outputBaseName(input.company, input.position, input.template === "cv" ? "cv" : "resume");

  // 1. Validate the shape.
  let content: TailoredContent;
  const parsed = TailoredContentSchema.safeParse(input.content);
  if (!parsed.success) {
    return {
      ok: false,
      outputBase: base,
      templateSource: "",
      provenance: { ok: false, errors: [], warnings: [] },
      error: `Content does not match the required schema:\n${parsed.error.issues
        .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`,
    };
  }
  content = parsed.data;

  // 2. Provenance — hard-fail on unknown ids (anti-fabrication).
  const master = await loadMasterCv();
  const provenance = checkProvenance(master, content);
  if (!provenance.ok) {
    return {
      ok: false,
      outputBase: base,
      templateSource: "",
      provenance,
      error: `Anti-fabrication check failed — every bullet must cite a real master-CV id:\n${provenance.errors
        .map((e) => `  • ${e}`)
        .join("\n")}`,
    };
  }

  // 3. Render. A finished document (no {{placeholders}}, native \roleheading/\bul
  // macros) gets section-body injection that preserves its formatting; a
  // {{token}} template gets the placeholder renderer.
  const { tex: template, source: templateSource } = await resolveTemplate({
    template: input.template,
    templateFile: input.templateFile,
    repoDir: input.repoDir,
  });
  let tex: string;
  if (isNativeDocument(template)) {
    tex = injectIntoDocument(template, content);
  } else {
    const renderOpts = input.headerLine ? { headerLine: input.headerLine } : {};
    tex = renderTemplate(template, master, content, renderOpts);
  }

  // 4. Structural validation.
  const validation = validateTex(tex);
  if (!validation.valid) {
    return {
      ok: false,
      outputBase: base,
      templateSource,
      provenance,
      validation,
      error: `Rendered LaTeX failed validation:\n${validation.errors.map((e) => `  • ${e}`).join("\n")}`,
    };
  }

  // 5. Write .tex + compile.
  await mkdir(config.outputDir, { recursive: true });
  const texPath = join(config.outputDir, `${base}.tex`);
  await writeFile(texPath, tex, "utf-8");

  const out: RenderOutput = { ok: true, outputBase: base, templateSource, texPath, provenance, validation };
  out.density = measureDensity(content);

  if (input.compile !== false) {
    const pdfPath = join(config.outputDir, `${base}.pdf`);
    const result = await compileTex(texPath, { outPdfPath: pdfPath, engine: config.latexEngine });
    if (!result.compiled) {
      out.ok = false;
      out.error = `LaTeX compilation failed:\n${result.error ?? "unknown error"}`;
      return out;
    }
    out.pdfPath = result.pdfPath;
    if (result.pageCount !== undefined) out.pageCount = result.pageCount;
    if (result.sizeBytes !== undefined) out.sizeKB = Math.round(result.sizeBytes / 102.4) / 10;
  }

  // 6. ATS coverage (optional).
  if (input.jobDescription?.trim()) {
    const keywords = extractKeywords(input.jobDescription);
    const text = latexToText(tex);
    const cov: CoverageResult = scoreCoverage(keywords, text);
    const masterText = await readFile(config.cvMasterPath, "utf-8");
    const gap = keywordGap(keywords, text, masterText);
    out.ats = { percent: cov.percent, matched: cov.matched, missing: cov.missing, gap };
  }

  // 7. Auto-log to the tracker so no application goes unrecorded. Upserts on
  //    company+position, so re-running a job updates its row instead of duplicating.
  const canTrack = Boolean(input.company?.trim() && input.position?.trim());
  if (canTrack && input.autoTrack !== false) {
    try {
      out.tracked = await recordApplication(config.trackerPath, {
        company: input.company!.trim(),
        position: input.position!.trim(),
        jobLink: input.jobUrl ?? "",
        atsScore: out.ats?.percent ?? "",
        resumeFile: out.pdfPath ? basename(out.pdfPath) : `${base}.tex`,
        cvFile: input.cvFile ?? "",
        coverLetterFile: input.coverLetterFile ?? "",
        jdSummary: input.jdSummary ?? summarizeJd(input.jobDescription),
        status: "generated",
      });
    } catch {
      // Tracking must never fail the document itself.
    }
  }

  return out;
}

export interface ApplicationSetInput {
  content: unknown;
  /** Optional fuller CV content. Defaults to the résumé content. */
  cvContent?: unknown;
  /** Cover letter content — omit to skip the letter. */
  coverLetter?: unknown;
  company: string;
  position: string;
  jobUrl?: string;
  jobDescription?: string;
  jdSummary?: string;
  headerLine?: string;
  templateFile?: string;
  /**
   * Also produce a CV (default **false**).
   *
   * Off by default because the CV renders from a *different* template than the
   * résumé — `templates/main.tex` is the résumé, while the CV falls back to the
   * bundled `cv-template.tex` unless you supply your own `templates/cv.tex`.
   * Generating both by default produced two documents in unrelated designs and
   * doubled the work for no benefit.
   */
  alsoCv?: boolean;
}

export interface ApplicationSetResult {
  resume: RenderOutput;
  cv?: RenderOutput;
  coverLetter?: { ok: boolean; pdfPath?: string; pageCount?: number; warnings: string[]; error?: string };
  tracked?: { created: boolean; total: number };
}

/**
 * Render a complete application: résumé, CV, and cover letter, then write a
 * single tracker row naming all three. Tracking happens once at the end so the
 * row is complete rather than being written before the other documents exist.
 */
export async function renderApplicationSet(input: ApplicationSetInput): Promise<ApplicationSetResult> {
  const baseName = outputBaseName(input.company, input.position);

  // 1. Résumé — tracking deferred until every document is known.
  const resume = await runRenderPipeline({
    content: input.content,
    template: "resume",
    templateFile: input.templateFile,
    company: input.company,
    position: input.position,
    outputName: baseName,
    headerLine: input.headerLine,
    jobDescription: input.jobDescription,
    jobUrl: input.jobUrl,
    autoTrack: false,
  });

  const result: ApplicationSetResult = { resume };
  if (!resume.ok) return result;

  // 2. CV — opt-in only (see ApplicationSetInput.alsoCv).
  if (input.alsoCv === true) {
    result.cv = await runRenderPipeline({
      content: input.cvContent ?? input.content,
      template: "cv",
      company: input.company,
      position: input.position,
      outputName: `${baseName}_CV`,
      headerLine: input.headerLine,
      jobDescription: input.jobDescription,
      autoTrack: false,
    });
  }

  // 3. Cover letter.
  if (input.coverLetter) {
    const { runCoverLetterPipeline } = await import("./coverLetter.js");
    const raw = input.coverLetter as Record<string, unknown>;
    const cl = await runCoverLetterPipeline({
      content: { ...raw, company: raw["company"] || input.company, position: raw["position"] || input.position },
    });
    result.coverLetter = {
      ok: cl.ok,
      pdfPath: cl.pdfPath,
      pageCount: cl.pageCount,
      warnings: [
        ...cl.claims.warnings,
        ...((cl.pageCount ?? 1) > 1 ? [`cover letter is ${cl.pageCount} pages — shorten it.`] : []),
      ],
      error: cl.error,
    };
  }

  // 4. One tracker row naming everything that was produced.
  try {
    result.tracked = await recordApplication(config.trackerPath, {
      company: input.company,
      position: input.position,
      jobLink: input.jobUrl ?? "",
      atsScore: resume.ats?.percent ?? "",
      resumeFile: resume.pdfPath ? basename(resume.pdfPath) : "",
      cvFile: result.cv?.pdfPath ? basename(result.cv.pdfPath) : "",
      coverLetterFile: result.coverLetter?.pdfPath ? basename(result.coverLetter.pdfPath) : "",
      jdSummary: input.jdSummary ?? summarizeJd(input.jobDescription),
      status: "generated",
    });
  } catch {
    // Tracking must never fail the documents themselves.
  }

  return result;
}

/** First ~200 chars of the JD, whitespace-collapsed — a usable tracker summary. */
function summarizeJd(jd?: string): string {
  if (!jd?.trim()) return "";
  const flat = jd.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 197)}...` : flat;
}

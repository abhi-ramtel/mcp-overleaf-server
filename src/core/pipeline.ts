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
import { isAbsolute, join, resolve } from "node:path";
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
  error?: string;
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

  return out;
}

/**
 * Compile a .tex file to PDF. Prefers latexmk (robust multi-pass); falls back to
 * running the raw engine twice. Parses the LaTeX log for a useful error message
 * and the page count, then cleans up auxiliary files.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, copyFile, rm, stat, mkdir } from "node:fs/promises";
import { dirname, join, basename, resolve } from "node:path";
import type { LatexEngine } from "../config.js";

const execFileAsync = promisify(execFile);

const AUX_EXTS = [".aux", ".log", ".out", ".fls", ".fdb_latexmk", ".synctex.gz", ".toc", ".bbl", ".blg"];
const toolCache = new Map<string, boolean>();

async function hasTool(cmd: string): Promise<boolean> {
  const cached = toolCache.get(cmd);
  if (cached !== undefined) return cached;
  try {
    await execFileAsync(cmd, ["--version"], { timeout: 15_000 });
    toolCache.set(cmd, true);
    return true;
  } catch {
    toolCache.set(cmd, false);
    return false;
  }
}

export interface CompileOptions {
  /** Destination PDF path. Defaults to the .tex path with a .pdf extension. */
  outPdfPath?: string;
  engine?: LatexEngine;
  timeoutMs?: number;
  /** Keep .aux/.log/etc after compiling (default false). */
  keepAux?: boolean;
}

export interface CompileResult {
  compiled: boolean;
  engine: string;
  pdfPath?: string;
  pageCount?: number;
  sizeBytes?: number;
  /** Measured from the PDF text bounds when Poppler's pdftotext is available. */
  pageUsage?: PdfPageUsage;
  /** First actionable LaTeX error(s) when compilation fails. */
  error?: string;
}

/** Text bounds on the final PDF page, in PostScript points (72 pt = 1 inch). */
export interface PdfPageUsage {
  pageHeightPoints: number;
  contentBottomYPoints: number;
  bottomWhitespacePoints: number;
}

const LATEXMK_MODE: Record<LatexEngine, string> = {
  latexmk: "-pdf",
  pdflatex: "-pdf",
  xelatex: "-xelatex",
  lualatex: "-lualatex",
};

const RAW_ENGINE: Record<LatexEngine, string> = {
  latexmk: "pdflatex",
  pdflatex: "pdflatex",
  xelatex: "xelatex",
  lualatex: "lualatex",
};

/** Extract the most useful lines from a LaTeX .log after a failed compile. */
async function extractLogError(logPath: string, fallback: string): Promise<string> {
  try {
    const log = await readFile(logPath, "utf-8");
    const bangs = log.split("\n").filter((l) => l.startsWith("!"));
    if (bangs.length > 0) return bangs.slice(0, 5).join("\n");
    // Otherwise surface the last few non-empty lines.
    const tail = log.split("\n").filter((l) => l.trim()).slice(-8).join("\n");
    return tail || fallback;
  } catch {
    return fallback;
  }
}

function parsePageCount(text: string): number | undefined {
  // pdflatex/latexmk print "Output written on <file> (N pages, M bytes)." — but
  // a long <file> wraps across lines in the log, so match the "(N pages, … bytes)"
  // tail, which never wraps. Fall back to a whitespace-collapsed match.
  const m = text.match(/\((\d+)\s+pages?,\s*\d+\s*bytes\)/);
  if (m) return Number(m[1]);
  const m2 = text.replace(/\s+/g, " ").match(/Output written on [^(]+\((\d+)\s+pages?/);
  return m2 ? Number(m2[1]) : undefined;
}

/**
 * Parse Poppler's `pdftotext -bbox` XHTML without taking a runtime dependency
 * on a PDF library. The final page is the meaningful one for a one-page
 * résumé: its lowest text reveals whether the visible lower third is empty.
 */
export function parsePdfPageUsage(xhtml: string): PdfPageUsage | undefined {
  const pages = [...xhtml.matchAll(/<page\b([^>]*)>([\s\S]*?)<\/page>/g)];
  const page = pages.at(-1);
  if (!page) return undefined;

  const heightMatch = page[1]?.match(/\bheight="([0-9.]+)"/);
  const pageHeightPoints = Number(heightMatch?.[1]);
  if (!Number.isFinite(pageHeightPoints) || pageHeightPoints <= 0) return undefined;

  let contentBottomYPoints = 0;
  for (const word of page[2]?.matchAll(/\byMax="([0-9.]+)"/g) ?? []) {
    const yMax = Number(word[1]);
    if (Number.isFinite(yMax)) contentBottomYPoints = Math.max(contentBottomYPoints, yMax);
  }
  if (contentBottomYPoints <= 0) return undefined;

  return {
    pageHeightPoints,
    contentBottomYPoints,
    bottomWhitespacePoints: Math.max(0, pageHeightPoints - contentBottomYPoints),
  };
}

/** Best-effort visual-layout measurement. Rendering still works without Poppler. */
async function inspectPdfPageUsage(pdfPath: string): Promise<PdfPageUsage | undefined> {
  try {
    const { stdout } = await execFileAsync("pdftotext", ["-bbox", pdfPath, "-"], {
      timeout: 15_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return parsePdfPageUsage(stdout ?? "");
  } catch {
    return undefined;
  }
}

export async function compileTex(texPath: string, opts: CompileOptions = {}): Promise<CompileResult> {
  const engine: LatexEngine = opts.engine ?? "latexmk";
  const timeout = opts.timeoutMs ?? 120_000;
  const absTex = resolve(texPath);
  const texDir = dirname(absTex);
  const texBase = basename(absTex, ".tex");
  const producedPdf = join(texDir, `${texBase}.pdf`);
  const logPath = join(texDir, `${texBase}.log`);

  const useLatexmk = await hasTool("latexmk");
  const rawEngine = RAW_ENGINE[engine];
  const usedEngine = useLatexmk ? `latexmk (${LATEXMK_MODE[engine]})` : rawEngine;

  let stdout = "";
  try {
    if (useLatexmk) {
      const args = [
        LATEXMK_MODE[engine],
        "-interaction=nonstopmode",
        "-halt-on-error",
        `-output-directory=${texDir}`,
        absTex,
      ];
      const r = await execFileAsync("latexmk", args, { cwd: texDir, timeout });
      stdout = r.stdout ?? "";
    } else {
      if (!(await hasTool(rawEngine))) {
        return {
          compiled: false,
          engine: usedEngine,
          error: `No LaTeX engine found. Install MacTeX/TeX Live (provides ${rawEngine} and latexmk).`,
        };
      }
      const args = [
        "-no-shell-escape",
        "-interaction=nonstopmode",
        "-halt-on-error",
        `-output-directory=${texDir}`,
        absTex,
      ];
      // Two passes to resolve references.
      await execFileAsync(rawEngine, args, { cwd: texDir, timeout });
      const r = await execFileAsync(rawEngine, args, { cwd: texDir, timeout });
      stdout = r.stdout ?? "";
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error = await extractLogError(logPath, message);
    if (!opts.keepAux) await cleanup(texDir, texBase);
    return { compiled: false, engine: usedEngine, error };
  }

  // Success — locate/move the PDF.
  let pdfPath = producedPdf;
  if (opts.outPdfPath) {
    const dest = resolve(opts.outPdfPath);
    await mkdir(dirname(dest), { recursive: true });
    if (dest !== producedPdf) {
      await copyFile(producedPdf, dest);
      await rm(producedPdf).catch(() => {});
      pdfPath = dest;
    }
  }

  let sizeBytes: number | undefined;
  try {
    sizeBytes = (await stat(pdfPath)).size;
  } catch {
    /* ignore */
  }

  let pageCount = parsePageCount(stdout);
  if (pageCount === undefined) {
    try {
      pageCount = parsePageCount(await readFile(logPath, "utf-8"));
    } catch {
      /* ignore */
    }
  }

  const pageUsage = await inspectPdfPageUsage(pdfPath);

  if (!opts.keepAux) await cleanup(texDir, texBase);

  const result: CompileResult = { compiled: true, engine: usedEngine, pdfPath };
  if (pageCount !== undefined) result.pageCount = pageCount;
  if (sizeBytes !== undefined) result.sizeBytes = sizeBytes;
  if (pageUsage !== undefined) result.pageUsage = pageUsage;
  return result;
}

async function cleanup(dir: string, base: string): Promise<void> {
  await Promise.all(AUX_EXTS.map((ext) => rm(join(dir, `${base}${ext}`)).catch(() => {})));
}

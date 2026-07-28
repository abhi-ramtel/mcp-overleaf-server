/**
 * Cover-letter rendering: structured content → LaTeX → compiled one-page PDF.
 *
 * Mirrors the résumé pipeline (escape → render → validate-ish → compile) but
 * uses a letter template and a lighter fabrication check, since narrative prose
 * can't carry per-bullet source ids the way résumé bullets do.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { config } from "../config.js";
import { escapeLatex } from "./latexRenderer.js";
import { compileTex } from "./latexCompile.js";
import { CoverLetterContentSchema, checkCoverLetterClaims } from "./schema.js";
import type { CoverLetterContent, ProvenanceReport } from "./schema.js";
import type { MasterCv } from "./types.js";
import { loadMasterCv, sanitizeFilePart } from "./pipeline.js";

function todayLong(): string {
  return new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

/** Contact line under the name — phone / email / portfolio, matching the résumé. */
function contactLine(cv: MasterCv): string {
  const parts: string[] = [];
  if (cv.contact.phone) parts.push(escapeLatex(cv.contact.phone));
  if (cv.contact.email) {
    parts.push(`\\href{mailto:${cv.contact.email}}{${escapeLatex(cv.contact.email)}}`);
  }
  for (const l of cv.contact.links) {
    if (/linkedin|github|portfolio|website/i.test(l.label)) {
      const display = l.url.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
      parts.push(`\\href{${l.url.replace(/([%#&])/g, "\\$1")}}{${escapeLatex(display)}}`);
    }
  }
  return parts.join(" $|$ ");
}

export interface CoverLetterResult {
  ok: boolean;
  outputBase: string;
  texPath?: string;
  pdfPath?: string;
  pageCount?: number;
  sizeKB?: number;
  claims: ProvenanceReport;
  error?: string;
}

export interface CoverLetterInput {
  content: unknown;
  /** Override the template (absolute, or relative to templates/). */
  templateFile?: string;
  outputName?: string;
  compile?: boolean;
}

async function resolveLetterTemplate(templateFile?: string): Promise<string> {
  const envFile = process.env.COVER_LETTER_TEMPLATE?.trim();
  const candidates = templateFile
    ? [templateFile]
    : envFile
      ? [envFile]
      : ["cover-letter.tex", "cover-letter-template.tex"];
  for (const name of candidates) {
    const p = isAbsolute(name) ? name : resolve(config.templatesDir, name);
    if (existsSync(p)) return readFile(p, "utf-8");
  }
  throw new Error(`No cover-letter template found (looked for: ${candidates.join(", ")}).`);
}

/** Render + compile a cover letter. */
export async function runCoverLetterPipeline(input: CoverLetterInput): Promise<CoverLetterResult> {
  const parsed = CoverLetterContentSchema.safeParse(input.content);
  if (!parsed.success) {
    return {
      ok: false,
      outputBase: "cover-letter",
      claims: { ok: false, errors: [], warnings: [] },
      error: `Cover letter content does not match the schema:\n${parsed.error.issues
        .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`,
    };
  }
  const content: CoverLetterContent = parsed.data;

  const base =
    (input.outputName ? sanitizeFilePart(input.outputName) : "") ||
    [content.company, content.position].map(sanitizeFilePart).filter(Boolean).join("_") + "_CoverLetter";

  const cv = await loadMasterCv();
  const masterText = await readFile(config.cvMasterPath, "utf-8");
  const claims = checkCoverLetterClaims(masterText, content);

  const recipient = content.recipient?.trim() || "Hiring Team";
  const recipientBlock = [
    `${escapeLatex(recipient)}\\\\`,
    `${escapeLatex(content.company)}${content.recipientAddress?.trim() ? `\\\\ ${escapeLatex(content.recipientAddress.trim())}` : ""}`,
  ].join("\n");

  const greeting = content.greeting?.trim() || `Dear ${recipient},`;
  const body = content.paragraphs.map((p) => escapeLatex(p.trim())).join("\n\n");

  const values: Record<string, string> = {
    NAME: escapeLatex(cv.contact.name),
    CONTACT_LINE: contactLine(cv),
    DATE: escapeLatex(content.date?.trim() || todayLong()),
    RECIPIENT_BLOCK: recipientBlock,
    GREETING: escapeLatex(greeting),
    BODY: body,
    CLOSING: escapeLatex(content.closing?.trim() || "Sincerely,"),
  };

  const template = await resolveLetterTemplate(input.templateFile);
  const tex = template.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => (k in values ? (values[k] ?? "") : m));

  const leftover = tex.match(/\{\{[A-Z_]+\}\}/g);
  if (leftover) {
    return { ok: false, outputBase: base, claims, error: `Unresolved placeholders: ${[...new Set(leftover)].join(", ")}` };
  }

  await mkdir(config.outputDir, { recursive: true });
  const texPath = join(config.outputDir, `${base}.tex`);
  await writeFile(texPath, tex, "utf-8");

  const out: CoverLetterResult = { ok: true, outputBase: base, texPath, claims };
  if (input.compile === false) return out;

  const pdfPath = join(config.outputDir, `${base}.pdf`);
  const result = await compileTex(texPath, { outPdfPath: pdfPath, engine: config.latexEngine });
  if (!result.compiled) {
    out.ok = false;
    out.error = `Cover letter compilation failed:\n${result.error ?? "unknown error"}`;
    return out;
  }
  out.pdfPath = result.pdfPath;
  if (result.pageCount !== undefined) out.pageCount = result.pageCount;
  if (result.sizeBytes !== undefined) out.sizeKB = Math.round(result.sizeBytes / 102.4) / 10;
  return out;
}

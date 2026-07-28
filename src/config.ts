/**
 * Central configuration: loads .env and resolves every path the server uses.
 *
 * All relative paths in .env resolve against the project root (the directory
 * that contains this package.json), NOT the caller's cwd — MCP clients launch
 * the server from arbitrary working directories, so cwd is never reliable.
 */
import { config as loadDotenv } from "dotenv";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Project root — one level up from src/ (or dist/). */
export const PROJECT_ROOT = path.resolve(HERE, "..");

// Load .env from the project root explicitly — MCP clients launch the server
// from an arbitrary cwd, so dotenv's default (cwd/.env) would miss it.
// quiet:true suppresses dotenv v17's promotional banner — critical for a stdio
// MCP server, where any stray stdout corrupts the JSON-RPC stream.
loadDotenv({ path: path.resolve(PROJECT_ROOT, ".env"), quiet: true });

/** Resolve an env path against PROJECT_ROOT, falling back to a default. */
function resolveEnvPath(key: string, fallback: string): string {
  const raw = process.env[key]?.trim();
  return path.resolve(PROJECT_ROOT, raw && raw.length > 0 ? raw : fallback);
}

export type LatexEngine = "latexmk" | "pdflatex" | "xelatex" | "lualatex";

const ENGINE = (process.env.LATEX_ENGINE?.trim() || "latexmk") as LatexEngine;

export const config = {
  /** Overleaf git token (username "git", token as password). */
  overleafToken: process.env.OL_GIT_AUTHENTICATION_TOKEN?.trim() ?? "",
  /** Optional default project URL / id (overridable per call). */
  defaultProject: process.env.OVERLEAF_PROJECT_URL?.trim() ?? "",

  /** Master CV markdown path. */
  cvMasterPath: resolveEnvPath("CV_MASTER_PATH", "cv.md"),
  /** Output directory for generated PDFs, .tex, and the tracker. */
  outputDir: resolveEnvPath("CAREER_OUTPUT_DIR", "output"),
  /** Bundled LaTeX templates. */
  templatesDir: path.resolve(PROJECT_ROOT, "templates"),
  /** Application tracker sheet (CSV, Excel-openable). */
  get trackerPath(): string {
    return path.join(this.outputDir, "applications.csv");
  },

  /** Where cloned Overleaf repos live (outside the project, in the OS temp dir). */
  reposDir: path.join(os.tmpdir(), "mcp-overleaf-projects"),

  /** LaTeX compile engine. */
  latexEngine: ENGINE,

  /** True when an Overleaf token is configured. */
  get hasOverleaf(): boolean {
    return this.overleafToken.length > 0;
  },
} as const;

export type Config = typeof config;

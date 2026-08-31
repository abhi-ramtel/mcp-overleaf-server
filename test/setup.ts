/**
 * Test sandbox: redirect every path derived from `config.outputDir` into a
 * throwaway directory.
 *
 * The suite calls `clearCache()`, writes tracker rows, and compiles real PDFs
 * through `config.outputDir`. Pointed at the project's own `output/`, a plain
 * `npm test` wipes `.tailoring-cache.json` — the cross-session reuse cache that
 * lets a later batch skip re-generating content for a role it has already
 * tailored — and drops stub PDFs and test rows among the user's applications.
 *
 * Loaded via `--import` so the env var is set before src/config.ts reads it:
 * static imports are hoisted, so assigning it inside a test file is too late.
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One directory per test process — node's runner executes test files in
// parallel children, and they must not clear each other's cache mid-run.
const sandbox = join(tmpdir(), "mcp-overleaf-server-tests", `${process.pid}-${Date.now()}`);
mkdirSync(sandbox, { recursive: true });

// dotenv does not override an already-set variable, so this wins over .env.
process.env.CAREER_OUTPUT_DIR = sandbox;

process.on("exit", () => {
  rmSync(sandbox, { recursive: true, force: true });
});

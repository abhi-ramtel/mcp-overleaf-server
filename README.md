# mcp-overleaf-server

An [MCP](https://modelcontextprotocol.io) server that tailors your **LaTeX résumé, CV, and cover letter** to any job description — injecting truthfully-selected content from a master `cv.md` into *your own* LaTeX document, compiling the PDF, and logging the application automatically. Paste a job description into any MCP client (Claude Desktop, Cursor, VS Code, Windsurf) and get back an ATS-optimized, one-page PDF.

> **Truthfulness is enforced by code, not just prompts.** The server refuses to compile any bullet that can't be traced back to your master CV, and flags any new number or skill for review.

---

## How it works

The reasoning (analyze the JD, rank experience, rewrite bullets) is done by **your MCP client's model** — no API key, no extra LLM cost. The server is a set of deterministic tools plus orchestrating prompts:

```
/tailor_resume "<paste JD>"
   │
   ├─ prepare_tailoring(JD)    → master CV (with ids) + JD keyword signals + rules + schema
   │      … your model reasons here → emits TailoredContent JSON …
   │         (only reorders/rewrites/shortens existing bullets; cites source ids)
   └─ render_and_compile(json + coverLetter)
          inject → validate → anti-fabrication check → compile
          → Company_Position.pdf + Company_Position_CoverLetter.pdf
          → auto-logged to output/applications.csv
```

---

## Requirements

- **Node.js ≥ 20** (developed on 26)
- **A LaTeX toolchain** — `latexmk` + `pdflatex` (install [MacTeX](https://tug.org/mactex/) / [TeX Live](https://tug.org/texlive/)). Check with `latexmk --version`.
- **An Overleaf git token** — *optional*, only for the Overleaf sync/push tools. Overleaf git access is a paid feature; everything else works without it.

## Setup

```bash
npm install && cp .env.example .env && npm run build
```

Put your master CV at `cv.md` (see `cv.example.md` for the structure — `## Summary`, `## Experience`, `## Projects`, `## Education`, `## Skills`), and drop your polished résumé at `templates/main.tex`. Both are gitignored — they never get published.

`.env`:

```ini
OL_GIT_AUTHENTICATION_TOKEN=olp_xxxxxxxxxxxx    # optional
OVERLEAF_PROJECT_URL=https://www.overleaf.com/project/xxxx   # optional
CV_MASTER_PATH=./cv.md
CAREER_OUTPUT_DIR=./output
LATEX_ENGINE=latexmk
```

## Connect to an MCP client

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "overleaf-resume": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/mcp-overleaf-server/dist/index.js"]
    }
  }
}
```

The server reads `.env` from its own directory, so secrets don't go in the config. Restart the client fully after editing. **Cursor / VS Code / Windsurf** use the same shape.

---

## Usage

### One job

In Claude Code, MCP prompts are namespaced — type `/mcp` to pick from the list, or:

```
/mcp__overleaf-resume__tailor_resume
```

with `jobDescription="…paste the posting…"`, `company="Acme"`, `position="Backend Engineer"`.

In Claude Desktop, prompts appear under the **➕** button, not as typed slash commands. Or just ask in chat: *"Tailor my resume for this job: `<paste>`"*.

This produces the résumé **and** a matching cover letter, then logs the application — all in one call.

### Many jobs at once (up to 10)

```
/mcp__overleaf-resume__tailor_multiple_jobs
```

Pass `jobs` as either JSON or `---`-separated blocks:

```
Company: Nuro
Position: Software Engineer
<paste the JD>
---
Company: Waymo
Position: Backend Engineer
<paste the JD>
```

**This is the credit-efficient path.** `batch_plan` clusters the jobs by keyword similarity and checks a cross-session cache, then tells the model exactly which jobs need fresh reasoning. Ten backend roles cost **one** reasoning pass, not ten — the rest are rendered from reused content. `batch_render` then compiles, writes cover letters, and logs every job in a single call.

```
Batch plan — 5 job(s), 2 reasoning pass(es) needed, 3 saved by reuse.

  #0  Nuro — Software Engineer      [resume]  →  GENERATE  ← write content for this one
  #1  Waymo — Backend Engineer      [resume]  →  reuse job #0 (similarity 0.78)
  #2  Figma — Frontend Engineer     [resume]  →  GENERATE  ← write content for this one
  #3  Linear — Frontend Engineer    [resume]  →  reuse job #2 (similarity 0.81)
  #4  Stripe — Backend Engineer     [resume]  →  reuse cache "acme|backend engineer" (0.72)
```

Tune reuse aggressiveness with `threshold` (0–1, default `0.65`) on `batch_plan`.

---

## Tools

| Tool | What it does |
|---|---|
| `prepare_tailoring` | Returns the brief: master CV with stable ids + JD keyword signals + rules + output schema |
| `render_and_compile` | Inject → validate → anti-fabrication check → compile → save `Company_Position.pdf`; **also renders the cover letter and auto-logs the application** |
| `render_cover_letter` | Standalone one-page cover letter (usually unnecessary — pass `coverLetter` to `render_and_compile` instead) |
| `batch_plan` | Clusters up to 10 jobs + checks the cache; reports which need fresh reasoning |
| `batch_render` | Renders, compiles, writes letters, and logs a whole batch in one call |
| `get_master_cv` | The parsed master CV with the ids used for tailoring |
| `ats_report` | Keyword coverage vs. a JD; splits gaps into *addable* (in your CV) vs *absent* |
| `update_tracker` / `list_applications` | Manual tracker access (logging is automatic) |
| `overleaf_sync` / `overleaf_commit_push` | Pull templates from / push results back to Overleaf |

## Your own LaTeX document

Point the server at `templates/main.tex` and it **auto-detects** which kind of file it is:

- **A finished résumé** (custom macros like `\roleheading` / `\bul`, no placeholders) → rewrites only the Summary / Experience / Projects / Skills section bodies. Your preamble, fonts, colors, spacing, and Education section are preserved byte-for-byte.
- **A `{{PLACEHOLDER}}` template** → the placeholder renderer fills each token.

### Project links

Write a project heading in `cv.md` as a markdown link and it stays hyperlinked in the compiled PDF:

```markdown
**[CarbonProxy](https://devpost.com/software/carbonproxy)** - Python, FastAPI, SQLite
```

→ `\projheading{\textbf{\href{...}{CarbonProxy}} $|$ \emph{...}}{Feb 2026}`

## The tracker sheet

`output/applications.csv` opens in Excel / Google Sheets and is git-diffable. Columns: Date Applied · Company · Position · Job Link · ATS % · Resume File · Git Link · JD Summary · Status · Notes.

Every render **auto-logs**, upserting on company+position — regenerating updates the row instead of duplicating.

## Architecture & design decisions

- **TypeScript, not Python.** The whole system is I/O orchestration (git, fs, subprocess, template injection). Building on the mature MCP TypeScript SDK avoided a rewrite and a second toolchain.
- **Host-model reasoning, not a server-side LLM.** The MCP client already has a capable model; calling an API server-side would need a key, double the cost, and duplicate the model. The server hands the model a structured brief and renders the JSON it returns. No key required.
- **Template injection, never LLM-generated LaTeX.** The renderer is the only component that emits LaTeX, and it escapes every field. Your macros and typography survive exactly.
- **Anti-fabrication by construction.** Every source bullet gets a stable id (`EXP1.2`). The model must cite one per bullet; unknown ids are a hard failure, and new numbers / off-CV skills become warnings. Cover letters get a prose-tuned variant that flags unverifiable figures. See `src/core/schema.ts`.
- **Reuse over regeneration.** Deterministic Jaccard similarity over JD keywords decides what can be reused — no model call is needed to decide what to skip. See `src/core/batch.ts`.
- **Graceful Overleaf degradation.** No git access (a paid feature) returns a normal "unavailable" result, not an error, and the failure is cached so the token is never re-spent.
- **CSV tracker, not a database.** Excel-openable, git-friendly, zero infrastructure.

## Project structure

```
src/
  index.ts              MCP bootstrap (tools + prompts, stdio)
  config.ts             env + resolved paths
  tools.ts              the MCP tools
  prompts.ts            tailor_resume + tailor_multiple_jobs
  core/
    cvParser.ts         cv.md → structured model with stable ids
    schema.ts           TailoredContent + CoverLetterContent (zod) + provenance checks
    latexRenderer.ts    structured content → LaTeX (escaping, macros, \href)
    documentInjector.ts rewrites section bodies of YOUR finished .tex
    latexValidate.ts    pre-compile structural checks
    latexCompile.ts     latexmk / pdflatex → PDF
    coverLetter.ts      one-page letter rendering
    batch.ts            similarity, clustering, cross-session cache, batch runner
    atsNormalize.ts     Unicode → ATS-safe ASCII
    keywords.ts         JD keyword extraction, coverage, gap analysis
    tracker.ts          CSV application sheet
    overleafGit.ts      project-URL → authed git; clone/pull/branch/commit/push
    brief.ts            the tailoring brief prepare_tailoring returns
    pipeline.ts         compose layer (render→validate→compile→save→log)
templates/              main.tex (yours, gitignored) · cv-template.tex · resume-template.tex
                        cover-letter-template.tex · AUTHORING.md
test/                   39 unit + integration tests (incl. real PDF compiles)
```

## Development

```bash
npm test         # 39 tests, including real latexmk compiles
npm run typecheck
npm run build
```

## Roadmap

Embedding-based bullet ranking · multiple role templates (SWE/AI-ML/Security/Quant) · preserving bold metrics through injection · optional server-side provider for a fully autonomous single call.

## License

MIT. Résumé template derived from the sb2nov / Gabriel Sison template (MIT).

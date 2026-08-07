# mcp-overleaf-server

An [MCP](https://modelcontextprotocol.io) server that tailors your **LaTeX résumé and cover letter** to any job description — injecting truthfully-selected content from a master `cv.md` into *your own* LaTeX document, compiling the PDF, and logging the application automatically. Paste a job description into any MCP client (Claude Desktop, Cursor, VS Code, Windsurf) and get back an ATS-optimized, one-page PDF.

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

All clients below launch the same process — `node /ABSOLUTE/PATH/mcp-overleaf-server/dist/index.js` — they just each want that command in their own config file/format. The server reads `.env` from its own directory, so secrets never need to go in any client config. **Always use the absolute path** (not `~` or a relative path) and **fully restart the client** after editing — MCP tool lists are only fetched at connection time.

### Claude Desktop / Cursor / VS Code / Windsurf

Add to `claude_desktop_config.json` (or the equivalent MCP settings in Cursor/VS Code/Windsurf — same shape):

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

See [examples/claude_desktop_config.json](examples/claude_desktop_config.json).

### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.overleaf-resume]
command = "node"
args = ["/ABSOLUTE/PATH/mcp-overleaf-server/dist/index.js"]
```

Or skip the file entirely:

```bash
codex mcp add overleaf-resume -- node /ABSOLUTE/PATH/mcp-overleaf-server/dist/index.js
```

Verify with `codex mcp list`. See [examples/codex_config.toml](examples/codex_config.toml).

### Gemini CLI

Add to `~/.gemini/settings.json` (global) — a project-level `.gemini/settings.json` works too, but this tool isn't tied to any one repo:

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

See [examples/gemini_settings.json](examples/gemini_settings.json). Gemini CLI expands `$VAR` references inside a server's `env` block if you ever need to inject a secret that way — not needed here since `.env` covers it.

### Ollama

Ollama itself is a model runtime, not an MCP client — it has no built-in concept of "MCP servers" to connect to. To use this server with a local Ollama model, put an MCP-aware layer in between:

- [mcp-client-for-ollama](https://github.com/jonigl/mcp-client-for-ollama) (`ollmcp`) — a terminal client that connects a local Ollama model to one or more MCP servers, this one included.
- [ollama-mcp-bridge](https://github.com/jonigl/ollama-mcp-bridge) — exposes MCP tools through Ollama's API for other tooling to consume.

Either way, the command you register is the same `node /ABSOLUTE/PATH/mcp-overleaf-server/dist/index.js` — consult that project's docs for exactly where its config lives.

---

## Usage

### First: how to invoke a prompt in your client

The two prompts (`tailor_resume`, `tailor_multiple_jobs`) surface differently depending on the client:

| Client | How to invoke |
|---|---|
| **Claude Code** | Type `/mcp` and pick from the list, or type the namespaced name: `/mcp__overleaf-resume__tailor_resume` |
| **Claude Desktop** | The **➕** button next to the message box — *not* a typed slash command |
| **Codex / Gemini CLI / Cursor** | Prompt support varies. If you don't see them, just ask in plain English (below) — the tools work regardless |

**You never actually need the prompts.** They're convenience wrappers. Asking in plain English works everywhere:

> Tailor my resume for this job and write a cover letter:
> *(paste the full posting)*

> [!IMPORTANT]
> **Paste the full posting text, not a URL.** Most job boards (Ashby, Greenhouse, Lever) render postings with JavaScript, so a link fetches nothing. An empty or stub `jobDescription` is now rejected outright — tailoring, ATS scoring, and the cover letter all depend on that text.

### One job

```
/mcp__overleaf-resume__tailor_resume
```

| Argument | Required | Notes |
|---|---|---|
| `jobDescription` | **yes** | The full posting text (≥100 chars) |
| `company` / `position` | recommended | Used for filenames and the tracker row |
| `jobUrl` | optional | Recorded in the tracker |
| `questions` | optional | Portal questions, one per line — answered in chat |
| `coverLetter` | optional | `"false"` to skip the letter (default: generate it) |
| `template` | optional | `"resume"` (default), or `"cv"` when you have supplied `templates/cv.tex` |

**Produces:** `Company_Position.pdf` and `Company_Position_CoverLetter.pdf`, plus one tracker row — all from a single `render_and_compile` call. A separate CV is only produced when you explicitly configure your own `templates/cv.tex` and pass `alsoCv: true`.

### Many jobs at once (up to 30)

```
/jobs
```

Pick how many jobs you're doing, and you get that many entry cards in the chat — company, role, URL, job description, application questions, cover letter on or off. Fill them in, hit **Tailor them**, and the batch runs. Leave company or role blank and they're read off the posting.

`/jobs` is a project skill (`.claude/skills/jobs/`) and needs a client that renders in-chat forms — the Claude Code desktop app does. Everywhere else, use the MCP prompt:

```
/mcp__overleaf-resume__tailor_multiple_jobs
```

Pass `jobs` as `---`-separated blocks. `Company:`, `Position:`, `Job URL:`, and `Question:` lines are parsed as fields; everything else is the description:

```
Company: Nuro
Position: Software Engineer
Question: Why do you want to work here?
<paste the full JD>
---
Company: Waymo
Position: Backend Engineer
<paste the full JD>
```

Or pass only a `location` argument pointing to a readable local file, attachment, or URL. The host model reads it, infers missing company/role/URL fields, and then follows the same batch flow. This is useful for a saved jobs list:

```text
LOCATION: /absolute/path/to/jobs.txt
```

The batch prompt prioritizes polished, standard one-page layouts: it uses four relevant experience entries when the master CV has them, gives the most relevant projects fuller sourced evidence, and retains master-CV skill labels. It fills a page with content rather than shrinking the template's professional type scale or margins.

**This is the credit-efficient path.** `batch_plan` does three things before any content is written: it **skips jobs you've already done**, clusters the rest by keyword similarity (checking a cross-session cache), and **splits the remaining work into chunks of three** — one `batch_render` call each, so no single call can run long enough to time out. That's what lets a batch go past ten jobs.

```
Batch plan — 8 job(s): 5 to render in 2 call(s) of up to 3, 3 skipped. 3 reasoning pass(es) needed, 2 saved by reuse.

SKIPPED — no work needed, do not render these:
  ⏭  #5  Nuro — Software Engineer: same company+position as job #0 in this list.
  ⏭  #6  Stripe — Backend Engineer: job description is 8 chars — paste the full posting.
  ⏭  #7  (no company) — Backend Engineer: missing company — read it off the posting.

── Chunk 1 of 2 — batch_render with these 3 job(s):
   [0]  Nuro — Software Engineer     [resume]  →  GENERATE  ← write content for this one
   [1]  Waymo — Backend Engineer     [resume]  →  reuseFrom: 0 (job [0] in this same call, similarity 0.78)
   [2]  Figma — Frontend Engineer    [resume]  →  GENERATE  ← write content for this one

── Chunk 2 of 2 — batch_render with these 2 job(s):
   [0]  Linear — Frontend Engineer   [resume]  →  reuseFrom: "figma|frontend engineer" (similarity 0.81)
   [1]  OpenAI — ML Engineer         [resume]  →  GENERATE  ← write content for this one
```

Tune with `threshold` (0–1, default `0.6`) — raise it toward `0.9` to force fresh reasoning per job. `chunkSize` overrides the three-per-call default (max 10).

> Reuse means an **identical** résumé body, not a re-tailored one. For a role you care about, run it single-job or raise the threshold.

#### Re-running is safe

A job already in `output/applications.csv` whose PDF is still on disk is **skipped, not rebuilt** — by both `batch_plan` and `batch_render`. So:

- Submitting the same list twice is a no-op instead of an error or a pile of overwritten files.
- A batch that died halfway through can be resumed by re-sending the whole list; only the missing jobs get built.
- Delete the row (or the PDF), or pass `force: true`, to deliberately redo one. Single-job `render_and_compile` always regenerates — it's the "redo this one" path.

Other things that used to break a run and now just get reported per job: duplicate entries in one list, a blank company or role, a stub job description, a reuse pointer whose target failed, and a cache entry that vanished between planning and rendering. One bad job never fails the call.

### Calling tools directly

You can ask for any individual tool by name instead of running a whole prompt:

| You want to… | Say something like |
|---|---|
| See your parsed CV and its IDs | *"Show me my master CV"* → `get_master_cv` |
| Score an existing résumé against a JD | *"ATS-check this resume against this posting"* → `ats_report` |
| Review what you've applied to | *"List my applications"* → `list_applications` |
| Add a row manually | *"Mark the Nuro application as applied"* → `update_tracker` |
| Write only a cover letter | *"Write a cover letter for X"* → `render_cover_letter` |
| Pull your Overleaf templates | *"Sync my Overleaf project"* → `overleaf_sync` |

### After it runs

Everything lands in `output/`:

```bash
open output/
```

- `Company_Position.pdf` — the one-page résumé
- `Company_Position_CoverLetter.pdf` — the letter
- `applications.csv` — the tracker (opens in Excel / Google Sheets)
- `.tailoring-cache.json` — reuse cache; delete it to force fresh reasoning

Read the tool's response before sending anything out. It reports **ATS coverage**, which missing keywords are *truthfully addable* vs. *absent from your CV*, any **provenance warnings** (a number or skill it couldn't trace to `cv.md`), and a warning if a document ran past one page.

### Troubleshooting

| Symptom | Cause |
|---|---|
| "No batch processing tool available" / tools missing | The client cached an old tool list — **fully quit and reopen it** (⌘Q, not just closing the window) |
| No cover letter produced | The model didn't pass `coverLetter`. Usually caused by an empty `jobDescription` — paste the real posting and re-run |
| "job description is empty or too short" | Working as intended — paste the posting text, not a URL |
| A job was skipped as "already generated" | It's in `applications.csv` with its PDF on disk. Pass `force: true`, or delete the row, to rebuild it |
| A batch stalls or the client drops the call | Too many jobs in one `batch_render`. Follow `batch_plan`'s chunks — three per call |
| "No cached content for key …" | The reuse cache was cleared between planning and rendering. Re-run `batch_plan` for the remaining jobs |
| Overleaf sync says unavailable | Overleaf git access is a paid feature. Not an error; local templates are used instead |
| Compile fails | Check `latexmk --version`; install MacTeX / TeX Live |

---

## Tools

| Tool | What it does |
|---|---|
| `prepare_tailoring` | Returns the brief: master CV with stable ids + JD keyword signals + rules + output schema |
| `render_and_compile` | Inject → validate → anti-fabrication check → compile → save `Company_Position.pdf`; **also renders the cover letter and auto-logs the application** |
| `render_cover_letter` | Standalone one-page cover letter (usually unnecessary — pass `coverLetter` to `render_and_compile` instead) |
| `batch_plan` | Up to 30 jobs: skips ones already done, clusters the rest, and chunks them 3 per render call |
| `batch_render` | Renders, compiles, writes letters, and logs one chunk; skips jobs already in the tracker |
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
- **Idempotent batches, chunked work.** The tracker is the record of what's done, so re-running a list rebuilds nothing and a half-finished batch resumes by re-submitting it. Work is handed back in groups of three rather than one long call, because a call long enough to time out is what actually loses a batch — and chunking is what lets one run exceed the ten-job per-call ceiling.
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
templates/              main.tex (yours, gitignored) · resume-template.tex
                        cover-letter-template.tex · AUTHORING.md
.claude/skills/jobs/    /jobs — the in-chat multi-job entry form
test/                   43 unit + integration tests (incl. real PDF compiles)
```

## Development

```bash
npm test         # 43 tests, including real latexmk compiles
npm run typecheck
npm run build
```

## Roadmap

Embedding-based bullet ranking · multiple role templates (SWE/AI-ML/Security/Quant) · preserving bold metrics through injection · optional server-side provider for a fully autonomous single call.

## License

MIT. Résumé template derived from the sb2nov / Gabriel Sison template (MIT).

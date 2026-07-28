# mcp-overleaf-server

An [MCP](https://modelcontextprotocol.io) server that tailors your **Overleaf LaTeX résumé & CV** to any job description — pulling your polished templates from Overleaf's git repo, injecting truthfully-selected content from a master `cv.md`, compiling the PDF, and logging the application in a tracker sheet. Paste a job description into any MCP client (Claude Desktop, Cursor, VS Code, Windsurf) and get an ATS-optimized, one-page PDF back.

> **Truthfulness is enforced by code, not just prompts.** The server refuses to compile any bullet that can't be traced back to your master CV, and flags any new number or skill for review.

---

## How it works

The reasoning (analyze the JD, rank experience, rewrite bullets) is done by **your MCP client's model** — no API key, no extra LLM cost. The server is a set of deterministic tools plus one orchestrating prompt. The "single command" is the `/tailor_resume` prompt, which sequences the tools with exactly one model-reasoning step in the middle:

```
/tailor_resume "<paste JD>"
   │
   ├─ overleaf_sync            pull latest templates from your Overleaf git repo
   ├─ prepare_tailoring(JD)    → master CV (with ids) + JD keyword signals + rules + schema
   │      … your model reasons here → emits TailoredContent JSON …
   │         (only reorders/rewrites/shortens existing bullets; cites source ids)
   ├─ render_and_compile(json) inject → validate → anti-fabrication check → compile PDF
   ├─ update_tracker           append a row: date, links, ATS score, resume file
   └─ overleaf_commit_push     (optional) push the tailored .tex to a branch
```

`render_and_compile` saves the PDF as `Company_Position.pdf` in `output/` and reports an ATS keyword-coverage score.

---

## Requirements

- **Node.js ≥ 20** (developed on 26)
- **A LaTeX toolchain** — `latexmk` + `pdflatex` (install [MacTeX](https://tug.org/mactex/) / [TeX Live](https://tug.org/texlive/)). Check with `latexmk --version`.
- **An Overleaf git token** (optional, only for the Overleaf sync/push tools) — Overleaf → *Account Settings → Git Integration → Generate token*.

## Setup

```bash
npm install
cp .env.example .env      # then fill in your token / project
```

Put your master CV at `cv.md` (see `cv.example.md` for the expected markdown structure — sections `## Summary`, `## Experience`, `## Projects`, `## Education`, `## Skills`).

`.env`:

```ini
OL_GIT_AUTHENTICATION_TOKEN=olp_xxxxxxxxxxxx
OVERLEAF_PROJECT_URL=https://www.overleaf.com/project/xxxxxxxxxxxxxxxxxxxxxxxx
CV_MASTER_PATH=./cv.md
CAREER_OUTPUT_DIR=./output
LATEX_ENGINE=latexmk
```

Build (recommended for client integration) or run in dev:

```bash
npm run build     # compiles to dist/ (recommended for client integration)
npm start         # or: npm run dev   (tsx, no build step)
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

The server reads `.env` from its own project directory, so you don't need to repeat secrets in the config. To override, add an `"env": { "OL_GIT_AUTHENTICATION_TOKEN": "…" }` block. For a no-build dev setup, use `"command": "npx"`, `"args": ["tsx", "/ABSOLUTE/PATH/src/index.ts"]`.

**Cursor / VS Code / Windsurf** use the same `command`/`args`/`env` shape in their MCP settings.

## Usage

Run the prompt (slash command in Claude Desktop):

```
/tailor_resume  jobDescription="…paste the posting…"  company="Acme"  position="Backend Engineer"
```

…or just ask in chat: *"Tailor my resume for this job: <paste>"* — the model will call `prepare_tailoring`, produce the content, and call `render_and_compile`.

## Tools

| Tool | What it does |
|---|---|
| `overleaf_sync` | Clone/pull your Overleaf project; list its `.tex` files |
| `get_master_cv` | Return the parsed master CV with the stable ids used for tailoring |
| `prepare_tailoring` | Return the brief: master CV + JD keyword signals + rules + output schema |
| `render_and_compile` | Inject content → validate → anti-fabrication check → compile PDF → save `Company_Position.pdf`; reports ATS coverage |
| `ats_report` | Score keyword coverage of a resume vs. a JD; split gaps into *addable* (in your CV) vs *absent* |
| `update_tracker` | Upsert a row in `output/applications.csv` |
| `list_applications` | List tracked applications |
| `overleaf_commit_push` | Commit (and optionally push) the tailored `.tex` back to Overleaf |

## The tracker sheet

`output/applications.csv` opens in Excel / Google Sheets and is git-diffable. Columns: Date Applied · Company · Position · Job Link · ATS % · Resume File · Git Link · JD Summary · Status · Notes. Re-recording the same company+position **updates** the row instead of duplicating.

## Architecture & design decisions

- **TypeScript, not Python.** The whole system is I/O orchestration (git, fs, subprocess, template injection). Building on the existing TS server and the mature MCP TypeScript SDK avoided a rewrite and a second toolchain.
- **Host-model reasoning, not a server-side LLM.** The MCP client already has a capable model; making the server call its own API would need a key, double the cost, and duplicate the model. Instead the server hands the model a structured brief (`prepare_tailoring`) and renders the structured JSON it returns. No key required.
- **Template injection, never LLM-generated LaTeX.** Templates are plain LaTeX with `{{PLACEHOLDER}}` tokens; `latexRenderer.ts` is the only component that emits LaTeX, escaping every field. Your macros, spacing, and typography are preserved exactly.
- **Anti-fabrication by construction.** `prepare_tailoring` stamps every source bullet with a stable id (`EXP1.2`). The model must cite an id per bullet; `render_and_compile` rejects unknown ids (hard error) and flags new numbers / off-CV skills (warnings). See `src/core/schema.ts`.
- **CSV tracker, not a database.** A sheet is what you asked to *review* — Excel-openable, git-friendly, zero infrastructure.
- **`latexmk` with a `pdflatex` fallback.** Robust multi-pass compilation; the engine is configurable.

## Project structure

```
src/
  index.ts              MCP bootstrap (tools + prompt, stdio)
  config.ts             env + resolved paths
  tools.ts              the 8 MCP tools
  prompts.ts            /tailor_resume orchestration prompt
  core/
    cvParser.ts         cv.md → structured model with stable ids
    schema.ts           TailoredContent (zod) + provenance / anti-fabrication check
    latexRenderer.ts    structured content → LaTeX (escaping, macros)
    latexValidate.ts    pre-compile structural checks
    latexCompile.ts     latexmk / pdflatex → PDF
    atsNormalize.ts     Unicode → ATS-safe ASCII
    keywords.ts         JD keyword extraction, coverage, gap analysis
    tracker.ts          CSV application sheet
    overleafGit.ts      project-URL → authed git; clone/pull/branch/commit/push
    brief.ts            the tailoring brief prepare_tailoring returns
    pipeline.ts         compose layer (render→validate→compile→save)
    tailoring.ts        identity mapping (no-LLM baseline)
templates/              cv-template.tex · resume-template.tex · AUTHORING.md
test/                   unit + integration tests
```

## Development

```bash
npm test         # unit + integration (incl. a real compile)
npm run typecheck
npm run build
```

## Roadmap

Cover-letter generation · embedding-based bullet ranking · multiple role templates (SWE/AI-ML/Security/Quant) · batch mode for many JDs · analysis caching · optional server-side provider (Claude/Gemini) for a fully autonomous single call.

## License

MIT. Résumé template derived from the sb2nov / Gabriel Sison template (MIT).
